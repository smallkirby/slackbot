import {constants, promises as fs} from 'fs';
import path from 'path';
import axios from 'axios';
// @ts-ignore
import {stripIndent} from 'common-tags';
import scrapeIt from 'scrape-it';
// @ts-ignore
import logger from '../lib/logger.js';
import type {SlackInterface} from '../lib/slack';

// User information
interface User {
  slackId: string,
  idCtf: string,      // can be empty to represent only user itself
}

// Challenge information per-site
interface Challenge {
  id: string,           // determined by the site
  name: string,
  score: number,        // score of the chall
  solvedBy: string[],   // IDs of Users who solve the chall
}

// Record of already added Site Information and Users
interface State {
	users: User[],
  contests: Contest[],
}

// Site Information
interface Contest{
  id: number,
  url: string,
  title: string,
  alias: string[],
  numChalls: number,
  joiningUsers: User[],
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

  const getContestSummary = async (contest: Contest) => {
    let text = "";
    text += `*${contest.title}* (${contest.url})\n`;
    text += `  問題数: ${contest.numChalls}\n`;
    if (contest.joiningUsers.length == 0) {
      text += `  参加者: なし\n`
    } else {
      text += `  参加者: ${contest.joiningUsers.length}匹\n`;
      text += `    \n`;
      for (let user of contest.joiningUsers) {
        text += "wai";//`${await getMemberIcon(user.slackname)}`; //XXX
      }
    }
    return text;
  }

  const checkUserExistsTW = async (idCtf: string) => {
    try {
      const { data: html } = await axios.get(`https://pwnable.tw/user/${idCtf}`, {
        headers: {},
      });
      console.log(`${idCtf}`);
      console.log(html);
      return true;
    } catch {
      console.log('not found');
      return false;
    }
  }

  // update challs and solved-state of pwnable.tw
  const updateChallsTW = async () => {
    // fetch data
    const { data: html } = await axios.get('https://pwnable.tw/challenge/', {
      headers: {}
    });
    const { fetchedChalls } = await scrapeIt.scrapeHTML<{ fetchedChalls: Challenge[] }>(html, {
      fetchedChalls: {
        listItem: 'li.challenge-entry',
        data: {
          name: {
            selector: 'div.challenge-info > .title > p > .tititle',
          },
          score: {
            selector: 'div.challenge-info > .title > p > .score',
            convert: (str_score) => Number(str_score.substring(0, str_score.length - ' pts'.length)),
          },
          id: {
            attr: 'id',
            convert: (id_str) => Number(id_str.substring('challenge-id-'.length)),
          }
        },
      }
    });
    logger.info(`pwnable.tw has ${fetchedChalls.length} challs.`);

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
  };

  // update challs and solved-state of pwnable.xyz
  const updateChallsXYZ = async () => {
    // fetch data
    const { data: html } = await axios.get('https://pwnable.xyz/challenges', {
      headers: {}
    });
    const { fetchedChalls } = await scrapeIt.scrapeHTML<{ fetchedChalls: Challenge[] }>(html, {
      fetchedChalls: {
        listItem: 'div.col-lg-2',
        data: {
          name: {
            selector: 'div.challenge > i',
          },
          score: {
            selector: 'div.challenge > p',
            convert: (str_score) => Number(str_score),
          },
          id: {
            selector: 'a',
            attr: 'data-target',
            convert: (id_str) => Number(id_str.substring('#chalModal'.length)),
          }
        },
      }
    });
    logger.info(`pwnable.xyz has ${fetchedChalls.length} challs.`);

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
  };

  rtm.on('message', async (message) => {
    if (message.text && message.subtype === undefined
      && message.text.startsWith('@pwnyaa')) {  // message is toward me
      const args = message.text.split(' ').slice(1);
      console.log(args);

      // show list of registered contests summary
      if (args[0] === 'list') {
        await slack.chat.postMessage({
          username: 'pwnyaa',
          icon_emoji: 'pwn',
          channel: message.channel,
          text: await (await Promise.all(state.contests.map(
            async (contest) => getContestSummary(contest)))).join(''),
        });
        // join the contest
      } else if (args[0] === 'join') {
        const selectedContestName = args[1];
        const selectedUserIdCtf = args[2];
        const slackUserId = message.user;
        if (!selectedContestName || !selectedUserIdCtf) { // Command format is invalid
          await slack.chat.postMessage({
            username: 'pwnyaa',
            icon_emoji: ':pwn:',
            channel: message.channel,
            text: stripIndent`
              *join* コマンド: ある常設CTFに登録する
                _join_  _<CTF name/alias>_  _<User ID>_
            `,
          });
        } else {
          const selectedContest = state.contests.find((contest) =>
            contest.alias == selectedContestName || contest.title == selectedContestName);
          if (!selectedContest) {   // specified contest is not registered
            await slack.chat.postMessage({
              username: 'pwnyaa',
              icon_emoji: ':pwn:',
              channel: message.channel,
              text: stripIndent`
                コンテスト *${selectedContestName}* は見つからなかったよ...
                現在登録されてるコンテスト一覧を見てね!
              `,
            })
            await slack.chat.postMessage({
              username: 'pwnyaa',
              icon_emoji: 'pwn',
              channel: message.channel,
              text: await (await Promise.all(state.contests.map(
                async (contest) => getContestSummary(contest)))).join(''),
            });

          } else {                  // add user to the contest and entire list
            if (!state.users.some((user) => slackUserId === user.slackId)) {
              setState({
                users: state.users.concat([{ slackId: slackUserId, idCtf: '' }]),
              });
            }
            await slack.reactions.add({
              name: 'ok',
              channel: message.channel,
              timestamp: message.ts,
            });

            // check whether user exists on the CTF
            if (await checkUserExistsTW(selectedUserIdCtf)) {
              console.log("OK");  // XXX
            } else {
              await slack.chat.postMessage({
                username: 'pwnyaa',
                icon_emoji: 'pwn',
                channel: message.channel,
                text: `ユーザ *${selectedUserIdCtf}* は *${selectedContest.title}* に見つからなかったよ:cry:`,
              });
            }
          }
        }

      // unknown command
      } else {
        await slack.chat.postMessage({
          username: 'pwnyaa',
          icon_emoji: ':pwn:',
          channel: message.channel,
          text: ':wakarazu:'
        })
      }
    }
  });

  // init
  updateChallsTW();
  updateChallsXYZ();
};