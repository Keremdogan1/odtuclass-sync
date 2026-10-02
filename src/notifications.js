const DEFAULT_NTFY_URL = 'https://ntfy.sh';

export async function notifyNewAssignment(assignment) {
	const topic = process.env.NTFY_TOPIC;

	if (!topic) {
		throw new Error('NTFY_TOPIC environment variable is required.');
	}

	const baseUrl = process.env.NTFY_URL || DEFAULT_NTFY_URL;
	const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(topic)}`;
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Title: `Yeni ödev: ${assignment.title}`,
			Tags: 'mortar_board',
		},
		body: `${assignment.courseName}\n${assignment.url || assignment.id}`,
	});

	if (!response.ok) {
		throw new Error(`ntfy notification failed: HTTP ${response.status}.`);
	}
}
