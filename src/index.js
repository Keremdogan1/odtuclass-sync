import { ODTUClassClient } from './odtuclass/client.js';
import { login } from './odtuclass/auth.js';
import { getCourses } from './odtuclass/courses.js';
import { getAssignments } from './odtuclass/assignments.js';
import { syncAssignments } from './sync.js';
import { notifyNewAssignment } from './notifications.js';
import { getPendingDirectory, writePendingAssignment } from './pending.js';

try {
	const username = process.env.ODTU_USERNAME;
	const password = process.env.ODTU_PASSWORD;

	if (!username || !password) {
		throw new Error(
			'ODTU_USERNAME and ODTU_PASSWORD environment variables are required.',
		);
	}

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
}
