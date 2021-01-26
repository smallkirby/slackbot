import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
// @ts-ignore
import scrapeIt from 'scrape-it';
// @ts-ignore
import logger from '../../lib/logger.js';
import qs from 'qs';
import axiosCookieJarSupport from 'axios-cookiejar-support';
import tough from 'tough-cookie';
import { Contest,Challenge, User } from './BasicTypes';

// update challs and solved-state of pwnable.xyz
export async function fetchChallsXYZ(){
  // fetch data
  const { data: html } = await axios.get('https://pwnable.xyz/challenges', {
    headers: {},
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

  //// register challenges
  //const oldxyz = state.contests.find((({ title }) => title == 'pwnable.xyz'));
  //const updatedxyz: Contest = {
  //  url: 'https://pwnable.xyz',
  //  id: 1,  // XXX
  //  title: 'pwnable.xyz',
  //  alias: !oldxyz ? ['xyz'] : oldxyz.alias,
  //  joiningUsers: !oldxyz ? [] : oldxyz.joiningUsers,
  //  numChalls: fetchedChalls.length,
  //}
  //if (!oldxyz) {
  //  state.contests.push(updatedxyz);
  //} else {
  //  state.contests.map(cont => cont.id === updatedxyz.id ? updatedxyz : cont);
  //}
  //setState(state);
};