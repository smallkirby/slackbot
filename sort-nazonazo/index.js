const axios = require('axios');
const { stripIndent } = require('common-tags');
const sample = require('lodash/sample');
const {
	getWordUrl,
	getCandidateWords,
} = require('../tahoiya/lib');

const BOTNAME = 'sort-nazonazo';
const TIMEOUT = 1000 * 60;

const getSortedString = (answer) => {
	return [...answer].sort((a, b) => {
		return a.codePointAt(0) - b.codePointAt(0);
	}).join('');
};

const getRandomTitle = async () => {
	const { data } = await axios.get(`https://ja.wikipedia.org/w/api.php`, {
		params: {
			action: 'query',
			format: 'json',
			list: 'random',
			rnnamespace: '0',
			rnlimit: '1',
		},
	});
	return data.query.random[0].title;
};

module.exports = async ({ rtmClient: rtm, webClient: slack }) => {
	const state = {
		title: null,
		answer: null,
		wordUrl: null,
		sorted: null,
		thread: null,
		timeoutId: null,
		clear() {
			state.title = null;
			state.answer = null;
			state.wordUrl = null;
			state.sorted = null;
			state.thread = null;
			state.timeoutId = null;
		},
	};

	const candidateWords = await getCandidateWords({ min: 0, max: Infinity });

	const command = /^ソートなぞなぞ\s*(?:([1-9][0-9]?)文字)?$/;

	rtm.on('message', async (message) => {
		if (message.channel !== process.env.CHANNEL_SANDBOX) {
			return;
		}

		if (command.test(message.text || '') && state.answer === null) {
			const length = Number((message.text.match(command) || [])[1]);

			let found;
			if (length) {
				found = candidateWords.filter(([_, answer]) => answer.length === length);
				if (found.length === 0) {
					found = candidateWords.filter(([_, answer]) => answer.length >= length);
				}
			}
			if (!found) {
				found = candidateWords;
			}

			const [title, answer, source, meaning, id] = sample(found);
			state.title = title;
			state.answer = answer;

			const sorted = getSortedString(answer);
			state.sorted = sorted;

			const wordUrl = getWordUrl(title, source, id);
			state.wordUrl = wordUrl;

			const { ts } = await slack.chat.postMessage({
				channel: process.env.CHANNEL_SANDBOX,
				text: stripIndent`
					ソート前の文字列を当ててね
					\`${sorted}\`
				`,
				username: BOTNAME,
			});
			state.thread = ts;

			const timeoutId = setTimeout(async () => {
				await slack.chat.postMessage({
					channel: process.env.CHANNEL_SANDBOX,
					text: stripIndent`
						答えは＊${state.title}＊／＊${state.answer}＊だよ
						${state.wordUrl}
					`,
					username: BOTNAME,
					thread_ts: state.thread,
					reply_broadcast: true,
				});
				state.clear();
			}, TIMEOUT);
			state.timeoutId = timeoutId;
		}

		if (state.answer !== null && message.thread_ts === state.thread && message.username !== BOTNAME) {
			if (message.text === state.answer) {
				clearTimeout(state.timeoutId);

				await slack.chat.postMessage({
					channel: process.env.CHANNEL_SANDBOX,
					text: stripIndent`
						<@${message.user}> 正解:tada:
						答えは＊${state.title}＊／＊${state.answer}＊だよ:muscle:
						${state.wordUrl}
					`,
					username: BOTNAME,
					thread_ts: state.thread,
					reply_broadcast: true,
				});
				state.clear();
			} else {
				await slack.reactions.add({
					name: 'no_good',
					channel: message.channel,
					timestamp: message.ts,
				});
			}
		}
	});
}
