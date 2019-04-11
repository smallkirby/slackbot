import fs from 'fs';
import {promisify} from 'util';
import path from 'path';
import assert from 'assert';
import {WebClient, RTMClient} from '@slack/client';
import {flatten, sum, sample, random, sortBy} from 'lodash';
// @ts-ignore
import trie from 'trie-prefix-tree';
// @ts-ignore
import cloudinary from 'cloudinary';
// @ts-ignore
import {stripIndent} from 'common-tags';
// @ts-ignore
import {hiraganize} from 'japanese';
import render from './render';

interface SlackInterface {
	rtmClient: RTMClient,
	webClient: WebClient,
}

const hiraganaLetters = 'ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろわをんー'.split('');

const getPrecedings = (index: number) => {
	const ret = [];
	const hasRight = index % 4 !== 3;
	const hasLeft = index % 4 !== 0;
	const hasUp = index >= 4;
	const hasDown = index < 12;
	if (hasRight) {
		ret.push(index + 1);
	}
	if (hasLeft) {
		ret.push(index - 1);
	}
	if (hasUp) {
		ret.push(index - 4);
	}
	if (hasDown) {
		ret.push(index + 4);
	}
	if (hasRight && hasUp) {
		ret.push(index - 3);
	}
	if (hasRight && hasDown) {
		ret.push(index + 5);
	}
	if (hasLeft && hasUp) {
		ret.push(index - 5);
	}
	if (hasLeft && hasDown) {
		ret.push(index + 3);
	}
	return ret;
};

const precedingsList = Array(16).fill(0).map((_, index) => getPrecedings(index));

const getPrefixedWords = (tree: any, letters: string[], prefix: string, bitmask: number, index: number) => {
	const ret: string[] = [];
	if (tree.hasWord(prefix)) {
		ret.push(prefix);
	}
	for (const preceding of precedingsList[index]) {
		if ((bitmask & (1 << preceding)) !== 0) {
			continue;
		}
		const letter = letters[preceding];
		if (!tree.isPrefix(prefix + letter)) {
			continue;
		}
		ret.push(...getPrefixedWords(tree, letters, prefix + letter, bitmask | (1 << preceding), preceding));
	}
	return ret;
}

const getWords = (tree: any, letters: string[]) => {
	const set = new Set<string>();
	for (const index of letters.keys()) {
	    const words = getPrefixedWords(tree, letters, '', 0, index);
		for (const word of words) {
		    set.add(word);
		}
	}
	return Array.from(set);
};

const generateBoard = (tree: any, seed: string) => {
	assert(seed.length <= 10);
	let board = null;
	while (board === null) {
		const tempBoard = Array(16).fill(null);
	    let pointer = random(0, 15);
		let failed = false;
		for (const index of Array(seed.length).keys()) {
		    tempBoard[pointer] = seed[index];
			if (index !== seed.length - 1) {
				const precedings = precedingsList[pointer].filter((cell) => tempBoard[cell] === null);
				if (precedings.length === 0) {
					failed = true;
					break;
				}
				pointer = sample(precedings);
			}
		}
		if (!failed) {
			board = tempBoard;
		}
	}

	while (board.some((letter) => letter === null)) {
		const [targetCellIndex] = sample([...board.entries()].filter(([, letter]) => letter === null));
		const prefixes = [];
		for (const preceding of precedingsList[targetCellIndex]) {
		    if (board[preceding] === null) {
				continue;
			}
			prefixes.push(board[preceding]);
			for (const preceding2 of precedingsList[preceding]) {
			    if (board[preceding2] === null || preceding === preceding2) {
					continue;
				}
				prefixes.push(board[preceding2] + board[preceding]);
			}
		}
		if (prefixes.length <= 4) {
			continue;
		}
		const counter = new Map(hiraganaLetters.map((letter) => [letter, 0]));
		for (const prefix of prefixes) {
		    for (const nextLetter of hiraganaLetters) {
		        counter.set(nextLetter, counter.get(nextLetter) + tree.countPrefix(prefix + nextLetter));
		    }
		}
		const topLetters = sortBy(Array.from(counter.entries()), ([, count]) => count).reverse().slice(0, 3);
		const [nextLetter] = sample(topLetters);
		board[targetCellIndex] = nextLetter;
	}

	return board;
};

export default async ({rtmClient: rtm, webClient: slack}: SlackInterface) => {
	const data = await Promise.all([
		promisify(fs.readFile)(path.join(__dirname, '..', 'tahoiya', 'wikipedia.txt')),
		promisify(fs.readFile)(path.join(__dirname, '..', 'tahoiya', 'nicopedia.txt')),
		promisify(fs.readFile)(path.join(__dirname, '..', 'tahoiya', 'wiktionary.txt')),
		promisify(fs.readFile)(path.join(__dirname, '..', 'tahoiya', 'ascii.txt')),
		promisify(fs.readFile)(path.join(__dirname, '..', 'tahoiya', 'binary.txt')),
		promisify(fs.readFile)(path.join(__dirname, '..', 'tahoiya', 'ewords.txt')),
		promisify(fs.readFile)(path.join(__dirname, '..', 'tahoiya', 'fideli.txt')),
	]);
	const dictionary = Array.from(new Set(flatten(data.map((datum) => (
		datum.toString().split('\n').map((line) => line.split('\t')[1])
	))))).filter((s) => (
		typeof s === 'string' && 2 <= s.length && s.length <= 16
	));
	const seedWords = dictionary.filter((word) => 7 <= word.length && word.length <= 8);
	const tree = trie(dictionary);
	const lightTree = trie(dictionary.filter((word) => word.length <= 5));

	const state: {
		thread: string,
		isHolding: boolean,
		words: string[],
		users: {[user: string]: string[]},
	} = {
		thread: null,
		isHolding: false,
		words: [],
		users: {},
	};

	rtm.on('message', async (message) => {
		if (!message.text || message.subtype || message.channel !== process.env.CHANNEL_SANDBOX) {
			return;
		}

		if (message.thread_ts && message.thread_ts === state.thread) {
			const word = hiraganize(message.text);
			if (!state.words.includes(word)) {
				await slack.reactions.add({
					name: '-1',
					channel: message.channel,
					timestamp: message.ts,
				});
				return;
			}
			if (Object.values(state.users).some((words) => words.includes(word))) {
				await slack.reactions.add({
					name: 'innocent',
					channel: message.channel,
					timestamp: message.ts,
				});
				return;
			}
			if (!state.users[message.user]) {
				state.users[message.user] = [];
			}
			state.users[message.user].push(word);
			await slack.reactions.add({
				name: '+1',
				channel: message.channel,
				timestamp: message.ts,
			});
			return;
		}

		if (message.text.match(/^wordhero$/i)) {
			if (state.isHolding) {
				return;
			}
			state.isHolding = true;
			const board = generateBoard(lightTree, sample(seedWords));
			state.words = getWords(tree, board).filter((word) => word.length >= 3);

			const imageData = await render(board);
			const cloudinaryData: any = await new Promise((resolve, reject) => {
				cloudinary.v2.uploader
					.upload_stream({resource_type: 'image'}, (error: any, response: any) => {
						if (error) {
							reject(error);
						} else {
							resolve(response);
						}
					})
					.end(imageData);
			});

			const message: any = await slack.chat.postMessage({
				channel: process.env.CHANNEL_SANDBOX,
				text: stripIndent`
					WordHeroを始めるよ～
					この画像から同じ場所を通らずタテ・ヨコ・ナナメにたどって見つけた3文字以上の単語を
					60秒以内に *スレッドで* 返信してね!
				`,
				username: 'wordhero',
				icon_emoji: ':capital_abcd:',
				attachments: [{
					title: 'WordHero',
					image_url: cloudinaryData.secure_url,
				}],
			});

			await slack.chat.postMessage({
				channel: process.env.CHANNEL_SANDBOX,
				text: '回答はこちらへどうぞ',
				thread_ts: message.ts,
				username: 'wordhero',
				icon_emoji: ':capital_abcd:',
			});

			state.thread = message.ts;

			setTimeout(async () => {
				if (Object.keys(state.users).length !== 0) {
					const ranking = Object.entries(state.users).map(([user, words]) => ({
						user,
						words,
						point: sum(words.map((word) => word.length ** 2)),
					})).sort((a, b) => b.point - a.point);
					const appearedWords = new Set(flatten(Object.values(state.users)));
					await slack.chat.postMessage({
						channel: process.env.CHANNEL_SANDBOX,
						text: stripIndent`
							結果発表～
						`,
						username: 'wordhero',
						icon_emoji: ':capital_abcd:',
						attachments: [
							...ranking.map(({user, words, point}, index) => ({
								text: `${index + 1}位. <@${user}> ${point}点 (${words.join('、')})`,
								color: index === 0 ? 'danger' : '#EEEEEE',
							})),
							{
								title: `単語一覧 (計${state.words.length}個)`,
								text: sortBy(state.words, (word) => word.length).reverse().map((word) => {
									if (appearedWords.has(word)) {
										return `*${word}*`
									}
									return word;
								}).join('\n'),
							},
						],
					});
				}
				state.isHolding = false;
				state.thread = null;
				state.users = {};
			}, 60 * 1000);
			return;
		}
	});
};