import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_NTFY_URL = 'https://ntfy.sh';
const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), '.odtuclass/config.json');

const DEFAULT_NTFY_FILTER = {
	assignment: true,
	quiz: true,
	recitation: true,
	lab: true,
	section: true,
	announcement: true,
	survey: false,
	attendance: false,
};

const CATEGORY_LABELS = {
	assignment: { prefix: 'Yeni ödev', tag: 'memo' },
	quiz: { prefix: 'Yeni quiz', tag: 'stopwatch' },
	recitation: { prefix: 'Yeni çalışma / recitation', tag: 'page_facing_up' },
	lab: { prefix: 'Yeni lab görevi', tag: 'microscope' },
	survey: { prefix: 'Yeni anket / seçim', tag: 'bar_chart' },
	announcement: { prefix: 'Yeni duyuru / etkinlik', tag: 'loudspeaker' },
	attendance: { prefix: 'Yoklama bildirimi', tag: 'clipboard' },
	section: { prefix: 'Yeni haftalık içerik', tag: 'books' },
};

export function loadNtfyFilter(configPath = DEFAULT_CONFIG_PATH) {
	const filter = { ...DEFAULT_NTFY_FILTER };

	try {
		if (fs.existsSync(configPath)) {
			const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			if (raw && typeof raw.ntfyFilter === 'object') {
				for (const [k, v] of Object.entries(raw.ntfyFilter)) {
					if (typeof v === 'boolean') {
						filter[k] = v;
					}
				}
			}
		}
	} catch (err) {
		console.warn(`[ntfy] Could not read config at ${configPath}: ${err.message}`);
	}

	// Optional environment variable override: NTFY_FILTER="assignment,quiz,lab,announcement"
	if (process.env.NTFY_FILTER) {
		const envList = process.env.NTFY_FILTER.split(',')
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		if (envList.length > 0) {
			for (const key of Object.keys(filter)) {
				filter[key] = envList.includes(key);
			}
		}
	}

	return filter;
}

export function classifyNotificationCategory(item) {
	if (!item) return 'assignment';
	if (item.notificationCategory) return item.notificationCategory;
	if (item.type === 'section') return 'section';

	const title = String(item.title || item.name || '');
	const courseName = String(item.courseName || '');
	const modType = String(item.moduleType || '').toLowerCase();

	if (modType === 'attendance' || /\b(?:attend[ae]nce|yoklama|roll[\s-]*call)\b/i.test(title)) {
		return 'attendance';
	}
	if (item.isTask === false || item.source === 'announcement' || modType === 'forum') {
		return 'announcement';
	}
	if (modType === 'choice' || modType === 'feedback' || modType === 'questionnaire') {
		return 'survey';
	}
	if (modType === 'quiz' || /\bquiz\b/i.test(title)) {
		return 'quiz';
	}
	if (
		item.source === 'calendar_lab' ||
		/\blab(s|oratory)?\b/i.test(courseName) ||
		/\b(?:pre[\s-]*lab|post[\s-]*lab|lab\s+report|experiment\s*\d+|deney\s*\d+)\b/i.test(title)
	) {
		return item.isTask === false ? 'announcement' : 'lab';
	}
	if (modType === 'pdf_assignment' || /\brecitation\b/i.test(title)) {
		return 'recitation';
	}
	if (item.source === 'calendar' && modType === 'calendar') {
		return 'announcement';
	}

	return 'assignment';
}

export function isNotificationEnabled(category, filter = loadNtfyFilter()) {
	return Boolean(filter[category]);
}

export async function notifyNewAssignment(assignment) {
	const topic = process.env.NTFY_TOPIC;

	if (!topic) {
		throw new Error('NTFY_TOPIC environment variable is required.');
	}

	const category = classifyNotificationCategory(assignment);
	const filter = loadNtfyFilter();

	if (!isNotificationEnabled(category, filter)) {
		console.log(
			`[ntfy] Skipping notification for "${assignment.title}" (category "${category}" is disabled by filter).`,
		);
		return false;
	}

	const meta = CATEGORY_LABELS[category] || CATEGORY_LABELS.assignment;
	const baseUrl = process.env.NTFY_URL || DEFAULT_NTFY_URL;
	const url = `${baseUrl.replace(/\/$/, '')}`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify({
			topic,
			title: `${meta.prefix}: ${assignment.title}`,
			message: `${assignment.courseName}\n${assignment.url || assignment.id}`,
			tags: [meta.tag],
		}),
	});

	if (!response.ok) {
		throw new Error(`ntfy notification failed: HTTP ${response.status}.`);
	}
	return true;
}

export async function notifySectionEvent(section, eventType) {
	const topic = process.env.NTFY_TOPIC;

	if (!topic) {
		throw new Error('NTFY_TOPIC environment variable is required.');
	}

	const filter = loadNtfyFilter();
	if (!isNotificationEnabled('section', filter)) {
		console.log(
			`[ntfy] Skipping section notification for "${section.courseName} - ${section.name}" (category "section" is disabled by filter).`,
		);
		return false;
	}

	const baseUrl = process.env.NTFY_URL || DEFAULT_NTFY_URL;
	const url = `${baseUrl.replace(/\/$/, '')}`;

	const actionLabel =
		eventType === 'updated'
			? 'Haftalık içerik güncellendi'
			: 'Yeni haftalık içerik';

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
	return true;
}
