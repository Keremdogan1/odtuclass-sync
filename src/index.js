import { ODTUClassClient } from './odtuclass/client.js';
import { login } from './odtuclass/auth.js';
import { getCourses } from './odtuclass/courses.js';
import { getAssignments } from './odtuclass/assignments.js';
import { getCourseSections } from './odtuclass/sections.js';
import { syncAssignments, syncSections } from './sync.js';
import { notifyNewAssignment, notifySectionEvent } from './notifications.js';
import {
	getPendingDirectory,
	writePendingAssignment,
	writePendingSection,
} from './pending.js';

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

	// --- 1. Assignments Pipeline ---
	try {
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
	} catch (assignmentError) {
		console.error('\n=== ASSIGNMENT PIPELINE ERROR ===');
		console.error(assignmentError.message);
	}

	// --- 2. Sections Pipeline (Isolated) ---
	try {
		console.log('\nFetching course sections...');

		const allSections = [];
		for (const course of courses) {
			try {
				const courseSections = await getCourseSections(client, course);
				allSections.push(...courseSections);
			} catch (courseSectionError) {
				console.warn(
					`Failed to fetch sections for course ${course.id}: ${courseSectionError.message}`,
				);
			}
		}

		console.log(`Found ${allSections.length} sections with content.`);

		const sectionSyncResult = await syncSections(allSections);
		const events = sectionSyncResult.sectionEvents || [];

		console.log(`Found ${events.length} section event(s).`);

		for (const sectionEvent of events) {
			const pendingPath = await writePendingSection(
				sectionEvent,
				getPendingDirectory(),
			);
			try {
				await notifySectionEvent(sectionEvent, sectionEvent.event);
			} catch (notifyError) {
				console.warn(
					`Failed to send notification for ${sectionEvent.id}: ${notifyError.message}`,
				);
			}
			console.log(
				`Pending section written (${sectionEvent.event}): ${pendingPath}`,
			);
		}
	} catch (sectionError) {
		console.error('\n=== SECTION PIPELINE ERROR ===');
		console.error(sectionError.message);
	}
} catch (error) {
	console.error('\n=== TEST FAILED ===');
	console.error(error.message);
	process.exitCode = 1;
}
