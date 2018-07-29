/* eslint-env node, jest */

const sushi = require('./index.js');
const Slack = require('../lib/slackMock.js');

let slack = null;

beforeEach(() => {
	slack = new Slack();
	sushi(slack);
});

it('reacts to "おすし"', () => new Promise((resolve) => {
	slack.on('reactions.add', ({name, channel, timestamp}) => {
		expect(name).toBe('sushi');
		expect(channel).toBe(slack.fakeChannel);
		expect(timestamp).toBe(slack.fakeTimestamp);
		resolve();
	});

	slack.rtmClient.emit('message', {
		channel: slack.fakeChannel,
		text: 'おすし',
		user: slack.fakeUser,
		ts: slack.fakeTimestamp,
	});
}));