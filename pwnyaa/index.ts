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
    for (let user of contest.joiningUsers) {
      //text += await getMemberIcon(user.slackId) + ' '; //XXX
      text += '   ' + user.slackId + ' ';
    }
    text += '\n';
  }
  return text;
}

const getChallsSummary = (challs: SolvedInfo[], spaces = 0) => {
  let text = '';
  for (let chall of challs) {
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

  // init
  updateChallsTW();
  updateChallsXYZ();
};
