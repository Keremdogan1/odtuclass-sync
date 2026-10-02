import { ODTUClassClient } from './odtuclass/client.js';
import { login } from './odtuclass/auth.js';
import { getCourses } from './odtuclass/courses.js';
import { getAssignments } from './odtuclass/assignments.js';
import { syncAssignments } from './sync.js';
import { notifyNewAssignment } from './notifications.js';
import { getPendingDirectory, writePendingAssignment } from './pending.js';
import readline from 'node:readline/promises';

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

async function readHiddenPassword(prompt) {
	if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
		const fallback = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		try {
			return await fallback.question(prompt);
		} finally {
			fallback.close();
		}
	}

	process.stdout.write(prompt);
	process.stdin.setRawMode(true);
	process.stdin.resume();

	return new Promise((resolve, reject) => {
		let password = '';

		const cleanup = () => {
			process.stdin.setRawMode(false);
			process.stdin.removeListener('data', onData);
		};

		const onData = (chunk) => {
			for (const character of chunk.toString()) {
				if (character === '\u0003') {
					cleanup();
					reject(new Error('Password input cancelled.'));
					return;
				}

				if (character === '\r' || character === '\n') {
					cleanup();
					process.stdout.write('\n');
					resolve(password);
					return;
				}

				if (character === '\u007f' || character === '\b') {
					password = password.slice(0, -1);
					continue;
				}

				password += character;
			}
		};

		process.stdin.on('data', onData);
	});
}

try {
	const username = await rl.question('ODTU username: ');
	rl.close();
	const password = await readHiddenPassword('ODTU password: ');

	const client = new ODTUClassClient(2026, 'f');

	await login(client, username, password);

	console.log('\nFetching courses...');

	const courses = await getCourses(client);

	console.log(`Found ${courses.length} courses.`);

	console.log('\nFetching assignments...');

	const assignments = await getAssignments(client, courses);

	console.log(`Found ${assignments.length} assignments:\n`);

	const syncResult = await syncAssignments(assignments);

	if (syncResult.firstRun) {
		console.log('Initial assignment state saved.');
	} else {
		console.log(`Found ${syncResult.newAssignments.length} new assignments.`);

		for (const assignment of syncResult.newAssignments) {
			const pendingPath = await writePendingAssignment(
				assignment,
				getPendingDirectory(),
			);
			await notifyNewAssignment(assignment);
			console.log(`Pending assignment written: ${pendingPath}`);
		}
	}

	for (const assignment of assignments) {
		console.log(
			`${assignment.id} | ` +
				`${assignment.courseName} | ` +
				`${assignment.title} | ` +
				`${assignment.dueAt ?? 'no due date'}`,
		);
	}
} catch (error) {
	console.error('\n=== TEST FAILED ===');
	console.error(error.message);
	process.exitCode = 1;
} finally {
	rl.close();
}
