import { apiCall } from './client.js';
import * as cheerio from 'cheerio';
import { extractSectionId, normalizeSectionHtml } from './sections.js';

const ASSIGNMENT_TYPES = new Set([
	'assign',
	'turnitintooltwo',
	'quiz',
	'hvp',
	'h5pactivity',
	'choice',
	'feedback',
	'questionnaire',
	'workshop',
	'lesson',
]);

const ADMIN_FORM_TYPES = new Set(['choice', 'feedback', 'questionnaire']);
const ADMIN_FORM_TITLE_REGEX =
	/\b(?:course\s+conflict|section\s+transfer|transfer\s+application|excuse\s+(?:form|application)|make-?up\s+(?:exam\s+)?application)\b/i;

function isAdministrativeForm(moduleType, title) {
	if (!ADMIN_FORM_TYPES.has(moduleType)) return false;
	return ADMIN_FORM_TITLE_REGEX.test(String(title || ''));
}

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
			if (isAdministrativeForm(module.modname, module.name)) {
				continue;
			}

			const dates = extractDates(module.dates || []);
			const isCompleted =
				module.completiondata?.state === 1 ||
				module.completiondata?.state === 2;

			assignments.push({
				id: `assignment:${course.id}:${module.id}`,
				type: 'assignment',
				courseId: course.id,
				courseName: course.fullname,
				sectionId: section.id || null,
				sectionName: section.name || null,
				sectionNumber: typeof section.section === 'number' ? section.section : null,
				moduleId: module.id,
				moduleType: module.modname,
				title: module.name || '?',
				url: module.url || '',
				openAt: dates.openAt,
				dueAt: dates.dueAt,
				closeAt: dates.closeAt,
				status: isCompleted ? 'done' : 'todo',
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

		// Bazen başlık span'da oluyor veya hoca link koymuyor, ancak mevcut mantık a.aalink arıyor. Buna dokunmuyoruz.
		if (!link.length) {
			return;
		}

		const linkClone = link.clone();
		linkClone.find('.accesshide').remove();
		const title = linkClone.text().trim() || link.text().trim();
		if (isAdministrativeForm(moduleType, title)) {
			return;
		}
		const url = link.attr('href') || '';
		const moduleId = extractModuleId(url);

		if (!moduleId) {
			return;
		}

		const dates = extractHtmlDates($, activity);

		const parentSection = activity.closest('li.section');
		let sectionId = null;
		let sectionName = null;
		let sectionNumber = null;

		if (parentSection.length) {
			const secLink = parentSection.find('a[href*="section.php"]').first();
			const secUrl = secLink.attr('href') || '';
			sectionId = secUrl ? extractSectionId(secUrl) : null;
			sectionName = secLink.text().trim() || parentSection.find('.sectionname').text().trim() || null;
			const secMatch = parentSection.attr('id')?.match(/section-(\d+)/);
			sectionNumber = secMatch ? parseInt(secMatch[1], 10) : null;
		}

		const completionRegion = activity.find('[data-region="completion-info"]');
		const completionText = completionRegion.text();
		const isCompleted =
			completionRegion.find('.btn-success, [data-toggletype*="undo"]').length > 0 ||
			/\b(done|tamamland[ıi])\b/i.test(completionText);

		assignments.push({
			id: `assignment:${course.id}:${moduleId}`,
			type: 'assignment',
			courseId: course.id,
			courseName: course.fullname,
			sectionId,
			sectionName,
			sectionNumber,
			moduleId,
			moduleType,
			title,
			url,
			openAt: dates.openAt,
			dueAt: dates.dueAt,
			closeAt: dates.closeAt,
			status: isCompleted ? 'done' : 'todo',
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
	let closeAt = null;

	for (const date of dates) {
		const label = (date.label || '').toLowerCase();

		if (label.includes('due')) {
			dueAt = date.timestamp || null;
		} else if (label.includes('close') || label.includes('cut-off') || label.includes('cutoff')) {
			closeAt = date.timestamp || null;
		} else if (label.includes('open')) {
			openAt = date.timestamp || null;
		}
	}

	return {
		openAt,
		dueAt,
		closeAt,
	};
}

function extractHtmlDates($, activity) {
	let openAt = null;
	let dueAt = null;
	let closeAt = null;

	const datesRegion = activity.find('div[data-region="activity-dates"] > div');
	datesRegion.each((_, el) => {
		const text = $(el).text().trim();
		const parts = text.split(':');
		if (parts.length >= 2) {
			const label = parts[0].trim().toLowerCase();
			const dateStr = parts.slice(1).join(':').trim();
			const isoDate = parseHumanDate(dateStr);

			if (label === 'opened' || label === 'opens' || label === 'open') {
				openAt = isoDate || openAt;
			} else if (label === 'due') {
				dueAt = isoDate || dueAt;
			} else if (label === 'closes' || label === 'close' || label === 'cut-off' || label === 'cutoff') {
				closeAt = isoDate || closeAt;
			}
		}
	});

	if (!openAt && !dueAt && !closeAt) {
		const description = activity.find('div.activity-description').text();
		const deadlineMatch = description.match(/deadline\s*:\s*([^\n<]+)/i);
		if (deadlineMatch) {
			dueAt = parseHumanDate(deadlineMatch[1].trim()) || dueAt;
		}
	}

	return { openAt, dueAt, closeAt };
}

function parseHumanDate(dateStr) {
	if (!dateStr) return null;
	const cleaned = dateStr.replace(/^[a-z]+,\s*/i, '').trim();
	const timestamp = Date.parse(cleaned + ' GMT+0300');
	if (!Number.isNaN(timestamp)) {
		return new Date(timestamp).toISOString();
	}
	return null;
}
