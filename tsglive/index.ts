import type {FastifyPluginCallback} from 'fastify';
import plugin from 'fastify-plugin';
import {liveDb as db} from '../lib/firestore';
import type {SlackInterface, SlashCommandEndpoint} from '../lib/slack';
import {getMemberName} from '../lib/slackUtils';

export const server = ({webClient: slack}: SlackInterface) => {
	const callback: FastifyPluginCallback = async (fastify, opts, next) => {
		const {team}: any = await slack.team.info();

		fastify.post<SlashCommandEndpoint>('/slash/tsglive', async (req, res) => {
			if (req.body.token !== process.env.SLACK_VERIFICATION_TOKEN) {
				res.code(400);
				return 'Bad Request';
			}
			if (req.body.team_id !== team.id) {
				res.code(200);
				return '/tsglive is only for TSG. Sorry!';
			}

			let teamId = null;
			if (req.body.channel_name === 'live-players-kanto') {
				teamId = 0;
			} else if (req.body.channel_name === 'live-players-kansai') {
				teamId = 1;
			} else {
				return '#live-players-kanto もしくは #live-players-kansai チャンネルから実行してください';
			}

			const name = await getMemberName(req.body.user_id);

			await db.collection('tsglive_comments').add({
				user: req.body.user_id,
				name,
				text: req.body.text,
				date: new Date(),
				team: teamId,
			});

			const emoji = teamId === 0 ? ':large_blue_circle:' : ':red_circle:';

			await slack.chat.postMessage({
				channel: req.body.channel_id,
				username: `${name} (tsg-live-controller)`,
				icon_emoji: emoji,
				text: req.body.text,
			});

			await slack.chat.postMessage({
				channel: 'C01AKTFRZGA', // #live-operation
				username: `${name} (tsg-live-controller)`,
				icon_emoji: emoji,
				text: req.body.text,
			});

			return '';
		});

		next();
	};

	return plugin(callback);
};
