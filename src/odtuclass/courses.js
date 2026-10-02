import { apiCall } from './client.js';

export async function getCourses(client) {
	const data = await apiCall(
		client,
		'core_course_get_enrolled_courses_by_timeline_classification',
		{
			offset: 0,
			limit: 0,
			classification: 'all',
			sort: 'fullname',
			customfieldname: '',
			customfieldvalue: '',
		},
	);

	return data.courses || [];
}
