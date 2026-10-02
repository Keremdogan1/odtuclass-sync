import { apiCall } from './client.js';
import * as cheerio from 'cheerio';

const ASSIGNMENT_TYPES = new Set([
	'assign',
	'turnitintooltwo',
	'quiz',
	'hvp',
	'h5pactivity',
]);

export async function getCourseContents(client, courseId) {
	return await apiCall(
		client,
		'core_course_get_contents',
		{
			courseid: courseId,
		},
	);
}

export async function getAssignments(client, courses) {
	const assignments = [];

	for (const course of courses) {
		let courseAssignments;

		try {
			const sections = await getCourseContents(client, course.id);
			courseAssignments = extractAssignmentsFromApi(course, sections);
		} catch (error) {
			console.warn(
				`API contents failed for ${course.id}, using HTML fallback...`,
			);
			courseAssignments = await scrapeAssignmentsFromHtml(client, course);
		}

		assignments.push(...courseAssignments);
	}

	return assignments;
}

function extractAssignmentsFromApi(course, sections) {
	const assignments = [];

	for (const section of sections || []) {
		for (const module of section.modules || []) {
			if (!ASSIGNMENT_TYPES.has(module.modname)) {
				continue;
			}

			const dates = extractDates(module.dates || []);

			assignments.push({
				id: `assignment:${course.id}:${module.id}`,
				type: 'assignment',
				courseId: course.id,
				courseName: course.fullname,
				moduleId: module.id,
				moduleType: module.modname,
				title: module.name || '?',
				url: module.url || '',
				openAt: dates.openAt,
				dueAt: dates.dueAt,
			});
			}
	}

	return assignments;
}

async function scrapeAssignmentsFromHtml(client, course) {
	const response = await client.request(
		'GET',
		`${client.baseUrl}/course/view.php?id=${course.id}`,
	);

	const $ = cheerio.load(response.data);
	const assignments = [];

	$('li.activity').each((_, element) => {
		const activity = $(element);
		let moduleType = null;

		for (const className of activity.attr('class')?.split(/\s+/) || []) {
			if (className.startsWith('modtype-')) {
				moduleType = className.replace('modtype-', '');
				break;
			}

			if (className.startsWith('modtype_')) {
				moduleType = className.replace('modtype_', '');
				break;
			}
		}

		if (!ASSIGNMENT_TYPES.has(moduleType)) {
			return;
		}

		const link = activity.find('a.aalink').first();

		if (!link.length) {
			return;
		}

		const title = link.text().trim();
		const url = link.attr('href') || '';
		const moduleId = extractModuleId(url);

		if (!moduleId) {
			return;
		}

		assignments.push({
			id: `assignment:${course.id}:${moduleId}`,
			type: 'assignment',
			courseId: course.id,
			courseName: course.fullname,
			moduleId,
			moduleType,
			title,
			url,
			openAt: null,
			dueAt: null,
		});
	});

	return assignments;
}

function extractModuleId(url) {
	try {
		const parsed = new URL(url);
		const id = parsed.searchParams.get('id');

		return id ? Number(id) : null;
	} catch {
		return null;
	}
}

function extractDates(dates) {
	let openAt = null;
	let dueAt = null;

	for (const date of dates) {
		const label = (date.label || '').toLowerCase();

		if (label.includes('due') || label.includes('close')) {
			dueAt = date.timestamp || null;
		} else if (label.includes('open')) {
			openAt = date.timestamp || null;
		}
	}

	return {
		openAt,
		dueAt,
	};
}
