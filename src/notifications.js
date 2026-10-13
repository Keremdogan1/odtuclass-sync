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
	assignment: { tr: 'Yeni ödev', en: 'New assignment', tag: 'memo' },
	quiz: { tr: 'Yeni quiz', en: 'New quiz', tag: 'stopwatch' },
	recitation: { tr: 'Yeni çalışma / recitation', en: 'New recitation / worksheet', tag: 'page_facing_up' },
	lab: { tr: 'Yeni lab görevi', en: 'New lab task', tag: 'microscope' },
	survey: { tr: 'Yeni anket / seçim', en: 'New survey / poll', tag: 'bar_chart' },
	announcement: { tr: 'Yeni duyuru / etkinlik', en: 'New announcement / event', tag: 'loudspeaker' },
	attendance: { tr: 'Yoklama bildirimi', en: 'Attendance notice', tag: 'clipboard' },
	section: { tr: 'Yeni haftalık içerik', en: 'New weekly content', tag: 'books' },
};

export function loadLanguage(configPath = DEFAULT_CONFIG_PATH) {
	if (process.env.ODTU_LANG) {
		const envLang = process.env.ODTU_LANG.trim().toLowerCase();
		if (envLang === 'en' || envLang === 'tr') return envLang;
	}
	try {
		if (fs.existsSync(configPath)) {
			const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			const cfgLang = String(raw?.language || '').trim().toLowerCase();
			if (cfgLang === 'en' || cfgLang === 'tr') return cfgLang;
		}
	} catch {
		// ignore
	}
	return 'tr';
}

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

	if (assignment.event === 'updated') {
		console.log(
			`[ntfy] Skipping notification for "${assignment.title}" (it is an existing assignment update, not a new assignment).`,
		);
		return false;
	}

	if (assignment.status === 'done') {
		console.log(
			`[ntfy] Skipping notification for "${assignment.title}" (assignment is already completed).`,
		);
		return false;
	}

	const lang = loadLanguage();
	const meta = CATEGORY_LABELS[category] || CATEGORY_LABELS.assignment;
	const prefix = meta[lang] || meta.tr;
	const baseUrl = process.env.NTFY_URL || DEFAULT_NTFY_URL;
	const url = `${baseUrl.replace(/\/$/, '')}`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify({
			topic,
			title: `${prefix}: ${assignment.title}`,
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

	const lang = loadLanguage();
	const baseUrl = process.env.NTFY_URL || DEFAULT_NTFY_URL;
	const url = `${baseUrl.replace(/\/$/, '')}`;

	const actionLabel =
		eventType === 'updated'
			? lang === 'en'
				? 'Weekly content updated'
				: 'Haftalık içerik güncellendi'
			: lang === 'en'
				? 'New weekly content'
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
