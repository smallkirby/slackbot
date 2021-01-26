import {constants, promises as fs} from 'fs';
import path from 'path';
// @ts-ignore
import {stripIndent} from 'common-tags';
// @ts-ignore
import logger from '../lib/logger.js';
import type {SlackInterface} from '../lib/slack';
import { ChatPostMessageArguments } from '@slack/web-api';
import { getMemberIcon, getMemberName } from '../lib/slackUtils';
import { fetchUserProfile, fetchChallsTW } from './lib/TWManager';
import { fetchChallsXYZ } from './lib/XYZManager';
import { Contest, User, Challenge, SolvedInfo } from './lib/BasicTypes';
import { Mutex } from 'async-mutex';
import schedule from 'node-schedule';
import { unlock } from '../achievements/index.js';

const mutex = new Mutex();

// Record of already added Site Information and Users
interface State {
	users: User[],
  contests: Contest[],
}

const getContestSummary = async (contest: Contest) => {
  let text = "";
  text += `*${contest.title}* (${contest.url})\n`;
  text += `  問題数: ${contest.numChalls}\n`;
  if (contest.joiningUsers.length == 0) {
    text += `  参加者: なし\n`
  } else {
    text += `  参加者: ${contest.joiningUsers.length}匹\n`;
    for (const user of contest.joiningUsers) {
      //text += await getMemberIcon(user.slackId) + ' '; //XXX
      text += '   ' + user.slackId + ' ';
    }
    text += '\n';
  }
  return text;
}

const filterChallSolvedRecent = (challs: SolvedInfo[], day: number) => {
  const limitdate = Date.now() - day * 1000 * 60 * 60 * 24;
  const filteredChalls = challs.filter((chall) => chall.solvedAt.getTime() >= limitdate);
  return filteredChalls;
}

const getChallsSummary = (challs: SolvedInfo[], spaces = 0) => {
  let text = '';
  for (const chall of challs) {
    text += " ".repeat(spaces);
    text += `${chall.name}(${chall.score}) ${chall.solvedAt.toLocaleString()}\n`;
  }
  return text;
}

export default async ({rtmClient: rtm, webClient: slack}: SlackInterface) => {
  // Restore state
  const statePath = path.resolve(__dirname, 'state.json');
  const exists = await fs.access(statePath, constants.F_OK)
    .then(() => true).catch(() => false);
  const state: State = {
    users: [],
    contests: [],
    ...(exists ? JSON.parse((await fs.readFile(statePath)).toString()) : {}),
  };
  await fs.writeFile(statePath, JSON.stringify(state));
  const setState = (object: { [key: string]: any }) => {
    Object.assign(state, object);
    return fs.writeFile(statePath, JSON.stringify(state));
  };

  const getUser = (slackid: string, contestname: string): User => {
    let found: User = null;
    state.contests.forEach((contest) => {
      if (contest.alias.some((alias) => alias == contestname)) {
        contest.joiningUsers.forEach((user) => {
          if (user.slackId == slackid)
            found = user;
        })
      }
    })
    return found;
  }

  const addUser2Ctf = async (slackId: string, ctfId: number, ctfUserId: string) => {
    let found = false;
    state.contests.forEach((contest, ci) => {
      if (contest.id === ctfId) {
        contest.joiningUsers.forEach((user, ui) => {
          if (user.slackId === slackId) {
            state.contests[ci].joiningUsers[ui].idCtf = ctfUserId;
            found = true;
          }
        })
        if (!found) {
          state.contests[ci].joiningUsers.push({ slackId: slackId, idCtf: ctfUserId });
        }
      }
    });
    setState(state);
  }

  const updateChallsTW = async () => {
    const fetchedChalls = await fetchChallsTW();

    // register challenges
    const oldtw = state.contests.find((({ title }) => title == 'pwnable.tw'));
    const updatedtw: Contest = {
      url: 'https://pwnable.tw',
      id: 0,  // XXX
      title: 'pwnable.tw',
      alias: !oldtw ? ['tw'] : oldtw.alias,
      joiningUsers: !oldtw ? [] : oldtw.joiningUsers,
      numChalls: fetchedChalls.length,
    }
    if (!oldtw) {
      state.contests.push(updatedtw);
    } else {
      state.contests.map(cont => cont.id === updatedtw.id ? updatedtw : cont);
    }
    setState(state);
    logger.info(`pwnable.tw has ${fetchedChalls.length} challs.`);
  }

  const updateChallsXYZ = async () => {
    const fetchedChalls = await fetchChallsXYZ();

    // register challenges
    const oldxyz = state.contests.find((({ title }) => title == 'pwnable.xyz'));
    const updatedxyz: Contest = {
      url: 'https://pwnable.xyz',
      id: 1,  // XXX
      title: 'pwnable.xyz',
      alias: !oldxyz ? ['xyz'] : oldxyz.alias,
      joiningUsers: !oldxyz ? [] : oldxyz.joiningUsers,
      numChalls: fetchedChalls.length,
    }
    if (!oldxyz) {
      state.contests.push(updatedxyz);
    } else {
      state.contests.map(cont => cont.id === updatedxyz.id ? updatedxyz : cont);
    }
    setState(state);
    logger.info(`pwnable.xyz has ${fetchedChalls.length} challs.`);
  }


  rtm.on('message', async (message) => {
    if (message.text && message.subtype === undefined
      && message.text.startsWith('@pwnyaa')) {  // message is toward me
      const args = message.text.split(' ').slice(1);
      console.log(args);

      // show list of registered contests summary
      if (args[0] === 'list') {
        await postMessageDefault(message, {
          text: await (await Promise.all(state.contests.map(
            async (contest) => getContestSummary(contest)))).join(''),
        });

        // join the contest
      } else if (args[0] === 'join') {
        const selectedContestName = args[1];
        const selectedUserIdCtf = args[2];
        const slackUserId = message.user;
        if (!selectedContestName || !selectedUserIdCtf) { // Command format is invalid
          await postMessageDefault(message, {
            text: stripIndent`
              *join* コマンド: ある常設CTFに登録する
                _join_  _<CTF name/alias>_  _<User ID>_
            `,
          });
        } else {
          const selectedContest = state.contests.find((contest) =>
            contest.alias == selectedContestName || contest.title == selectedContestName);
          if (!selectedContest) {   // specified contest is not registered
            await postMessageDefault(message, {
              text: stripIndent`
                コンテスト *${selectedContestName}* は見つからなかったよ...
                現在登録されてるコンテスト一覧を見てね!
              `,
            });
            await postMessageDefault(message, {
              text: await (await Promise.all(state.contests.map(
                async (contest) => getContestSummary(contest)))).join(''),
            });

          } else {                  // add user to the contest and entire list
            if (!state.users.some((user) => slackUserId === user.slackId)) {
              setState({
                users: state.users.concat([{ slackId: slackUserId, idCtf: '' }]),
              });
            }
            await addReactionDefault(message, 'ok');

            // check whether user exists on the CTF
            const userProfile = await fetchUserProfile(selectedUserIdCtf);
            if (userProfile) {
              await addUser2Ctf(message.user, selectedContest.id, selectedUserIdCtf);
              await postMessageDefault(message, {
                text: stripIndent`
                  登録したよ! :azaika:
                    ユーザ名  : ${userProfile.username}
                    スコア   : ${userProfile.score}
                    ランキング: ${userProfile.rank}
                    ${userProfile.comment}
                `,
              });
            } else {
              await postMessageDefault(message, {
                text: `ユーザ *${selectedUserIdCtf}* は *${selectedContest.title}* に見つからなかったよ:cry:`,
              });
            }
          }
        }

        // check user status of the specified CTF.
      } else if (args[0] == 'check') {
        const selectedContestName = args[1];
        if (!selectedContestName) { // Command format is invalid
          await postMessageDefault(message, {
            text: stripIndent`
              *check* コマンド: あるCTFにおける自分のステータス確認
                _join_  _<CTF name/alias>_
            `,
          });
        } else {
          const user = getUser(message.user, selectedContestName);
          if (!user) {
            await postMessageDefault(message, {
              text: stripIndent`
                まだ *${selectedContestName}* に参加してないよ。 *join* コマンドで参加登録してね!
              `,
            })
          } else {
            const fetchedProfile = await fetchUserProfile(user.idCtf);
            await postMessageDefault(message, {
              text: stripIndent`
                *${fetchedProfile.username}* の情報だよ！スレッドを見てね。
              `,
            })
						await postMessageThreadDefault(message, {
							text: stripIndent`
ユーザ名  : ${fetchedProfile.username}
スコア   : ${fetchedProfile.score}
ランキング: ${fetchedProfile.rank}
${fetchedProfile.comment} \n
解いた問題:
${getChallsSummary(fetchedProfile.solvedChalls, 2)}
								`,
            })
          }
        }

      } else if (args[0] == 'debug') {
        postDaily();
        postWeekly();

      // unknown command
      } else {
        await postMessageDefault(message, { text: ':wakarazu:' });
      }
    }
  });

  const postMessageDefault = async (receivedMessage: any, config = {}) => {
    const postingConfig: ChatPostMessageArguments = {
      username: 'pwnyaa',
      icon_emoji: ':pwn:',
      channel: receivedMessage.channel,
      text: '',
      ...config,
    }
    await slack.chat.postMessage(postingConfig);
  }

  const addReactionDefault = async (receivedMessage: any, emoji: string) => {
    await slack.reactions.add({
      name: emoji,
      channel: receivedMessage.channel,
      timestamp: receivedMessage.ts,
    });
  }

  const postMessageThreadDefault = async (receivedMessage: any, config = {}) => {
    const postingConfig: ChatPostMessageArguments = {
      username: 'pwnyaa',
      icon_emoji: ':pwn:',
      channel: receivedMessage.channel,
      thread_ts: receivedMessage.ts,
      text: '',
      ...config,
    }
    await slack.chat.postMessage(postingConfig);
  }

	const checkAchievementsTW = async () => {
		const contestTW = state.contests.find((contest) => contest.id == 0);
		for (const user of contestTW.joiningUsers) {
			const profile = await fetchUserProfile(user.idCtf);
			if (profile.solvedChalls.length >= contestTW.numChalls) {
				console.log("UNLOCKING COMP...");
				await unlock(user.slackId, 'pwnyaa-tw-complete');
			}
			if (profile.solvedChalls.length >= contestTW.numChalls / 2) {
				console.log("UNLOCKING HAL...");
				await unlock(user.slackId, 'pwnyaa-tw-halr');
			}
		}
	}

  const postDaily = async () => {
		// for now, retrieve only TW. // XXX
		let nobody = true;
    for (const contest of state.contests) {
      let text = '';
      if (contest.id == 0) { // TW
        text += `*${state.contests.find((contest) => contest.id == 0).title}*\n`;
        const allRecentSolves: {slackid: string, solves: SolvedInfo[]}[] = [];
        const users = contest.joiningUsers;
        for (const user of users) {
          const profile = await fetchUserProfile(user.idCtf);
          const recentSolves = filterChallSolvedRecent(profile.solvedChalls, 1);
          allRecentSolves.push({ slackid: user.slackId, solves: recentSolves });
					if (recentSolves.length > 0)
						nobody = false;
        }

        for (const solvePerUser of allRecentSolves) {
          for (const solve of solvePerUser.solves) {
            text += `*${solvePerUser.slackid}* が *${solve.name}* (${solve.score})を解いたよ :pwn: \n`
          }
				}
				if (!nobody) {
					slack.chat.postMessage({
						username: 'pwnyaa',
						icon_emoji: ':pwn',
						channel: process.env.CHANNEL_SANDBOX,
						text: text,
					});
				}
      }
		}

		await checkAchievementsTW();
  }

  const postWeekly = async () => {
		// for now, retrieve only TW.
		let nobody = true;
    const ranking: { slackid: string, solves: number }[] = [];
    for (const contest of state.contests) {
      if (contest.id == 0){ // TW
        const users = contest.joiningUsers;
        for (const user of users) {
          const profile = await fetchUserProfile(user.idCtf);
					const recentSolves = filterChallSolvedRecent(profile.solvedChalls, 7);
					ranking.push({ slackid: user.slackId, solves: recentSolves.length });
					if (recentSolves.length > 0) {
						nobody = false;
					}
        }
      };
    }

    ranking.sort((l, r) => r.solves - l.solves);
    let text = '';
    if (!nobody) {
      text += '今週のpwnランキングを発表するよ〜\n';
      for (const [ix, user] of ranking.entries()) {
        text += `*${ix+1}* 位: *${user.slackid}* \t\t${user.solves} solves \n`;
      }
      text += '\nおめでとう〜〜〜〜〜〜〜〜 :genius:\n'
    } else {
      text += '今週は誰も問題を解かなかったよ... :cry:\n';
    }

    slack.chat.postMessage({
      username: 'pwnyaa',
      icon_emoji: ':pwn',
      channel: process.env.CHANNEL_SANDBOX,
      text: text,
    });
  }

  setInterval(() => {
    mutex.runExclusive(() => {
      updateChallsTW();
      updateChallsTW();
    });
  }, 30 * 60 * 1000);

  // init
  updateChallsTW();
  updateChallsXYZ();

  // set schedules
  schedule.scheduleJob('0 9 * * *', () => {
    mutex.runExclusive(() => {
      postDaily();
    })
  });

  schedule.scheduleJob('0 9 * * 0', () => {
    mutex.runExclusive(() => {
      postWeekly();
    })
  });
};
