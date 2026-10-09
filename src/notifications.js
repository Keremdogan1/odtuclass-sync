const DEFAULT_NTFY_URL = 'https://ntfy.sh';

export async function notifyNewAssignment(assignment) {
	const topic = process.env.NTFY_TOPIC;

	if (!topic) {
		throw new Error('NTFY_TOPIC environment variable is required.');
	}

	const baseUrl = process.env.NTFY_URL || DEFAULT_NTFY_URL;
	const url = `${baseUrl.replace(/\/$/, '')}`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify({
			topic,
			title: `Yeni ödev: ${assignment.title}`,
			message: `${assignment.courseName}\n${assignment.url || assignment.id}`,
			tags: ['bell'],
		}),
	});

	if (!response.ok) {
		throw new Error(`ntfy notification failed: HTTP ${response.status}.`);
	}
}

export async function notifySectionEvent(section, eventType) {
	const topic = process.env.NTFY_TOPIC;

	if (!topic) {
		throw new Error('NTFY_TOPIC environment variable is required.');
	}

	const baseUrl = process.env.NTFY_URL || DEFAULT_NTFY_URL;
	const url = `${baseUrl.replace(/\/$/, '')}`;

	const actionLabel =
		eventType === 'updated'
			? 'ODTUClass içeriği güncellendi'
			: 'Yeni ODTUClass içeriği';

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify({
			topic,
			title: `${actionLabel}: ${section.courseName} - ${section.name}`,
			message: `${section.courseName}\n${section.url || section.id}\n\n${section.content ? section.content.substring(0, 300) : ''}`,
			tags: ['books'],
		}),
	});

	if (!response.ok) {
		throw new Error(`ntfy notification failed: HTTP ${response.status}.`);
	}
}
