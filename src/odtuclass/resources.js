import { getCourseContents } from './assignments.js';

export async function getCourseResources(client, courses) {
	const resources = [];

	for (const course of courses) {
		try {
			const sections = await getCourseContents(client, course.id);
			const courseResources = extractResourcesFromApi(course, sections);
			resources.push(...courseResources);
		} catch (error) {
			console.warn(
				`Failed to fetch course contents for resources in course ${course.id}: ${error.message}`,
			);
		}
	}

	return resources;
}

export function extractResourcesFromApi(course, sections) {
	const resources = [];

	for (const section of sections || []) {
		for (const module of section.modules || []) {
			if (module.modname !== 'resource') {
				continue;
			}

			const contents = module.contents || [];
			for (const file of contents) {
				const filename = file.filename || '';
				const mimetype = (file.mimetype || '').toLowerCase();
				const isPdf =
					mimetype === 'application/pdf' ||
					filename.toLowerCase().endsWith('.pdf') ||
					(file.fileurl && file.fileurl.toLowerCase().includes('.pdf'));

				if (isPdf) {
					resources.push({
						id: `resource:${course.id}:${module.id}`,
						type: 'resource',
						courseId: course.id,
						courseName: course.fullname,
						sectionId: section.id,
						sectionName: section.name,
						moduleId: module.id,
						name: module.name || filename,
						filename,
						fileurl: file.fileurl,
						filesize: file.filesize,
						timecreated: file.timecreated,
						timemodified: file.timemodified,
					});
				}
			}
		}
	}

	return resources;
}

export async function fetchResourceBuffer(client, fileurl) {
	if (!fileurl) {
		throw new Error('fileurl is required to fetch resource buffer.');
	}

	const response = await client.request('GET', fileurl, null, {
		responseType: 'arraybuffer',
	});

	return Buffer.from(response.data);
}
