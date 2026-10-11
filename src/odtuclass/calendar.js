import * as cheerio from 'cheerio';
import { apiCall } from './client.js';
import {
	parseWeekDates,
	normalizeSectionHtml,
	computeContentHash,
	extractSectionId,
} from './sections.js';

/**
 * Fetch raw calendar events from ODTUClass using Moodle AJAX endpoints + HTML fallback.
 */
export async function getCalendarEvents(client, courses, options = {}) {
	const { lookAheadDays = 120, lookBehindDays = 14 } = options;

	const courseIds = courses.map((c) => Number(c.id));
	const courseMap = new Map(courses.map((c) => [Number(c.id), c]));

	const now = Math.floor(Date.now() / 1000);
	const timestart = now - lookBehindDays * 86400;
	const timeend = now + lookAheadDays * 86400;

	const events = new Map();

	const addEvent = (rawEvent, defaultSource) => {
		if (!rawEvent || !rawEvent.id) return;
		if (rawEvent.eventtype === 'site' || rawEvent.eventtype === 'category') return;

		const courseid = Number(
			rawEvent.course?.id || rawEvent.courseid || rawEvent.courseId || 0,
		);
		if (!courseid || !courseMap.has(courseid)) return;

		const key = `${courseid}:${rawEvent.id}`;
		if (!events.has(key)) {
			events.set(key, {
				...rawEvent,
				courseid,
				_source: defaultSource,
			});
		} else {
			const existing = events.get(key);
			if (rawEvent.action && !existing.action) existing.action = rawEvent.action;
			if (rawEvent.url && !existing.url) existing.url = rawEvent.url;
			if (rawEvent.description && !existing.description) {
				existing.description = rawEvent.description;
			}
			if (rawEvent.location && !existing.location) {
				existing.location = rawEvent.location;
			}
		}
	};

	// 1. core_calendar_get_action_events_by_timesort (works on Moodle Dashboard AJAX)
	try {
		const timesortData = await apiCall(
			client,
			'core_calendar_get_action_events_by_timesort',
			{
				timesortfrom: timestart,
				timesortto: timeend,
				limitnum: 50,
			},
		);
		for (const ev of timesortData?.events || []) {
			addEvent(ev, 'action_timesort');
		}
	} catch (err) {
		console.warn(
			`[Calendar] core_calendar_get_action_events_by_timesort note: ${err.message}`,
		);
	}

	// 2. core_calendar_get_action_events_by_courses
	try {
		const actionData = await apiCall(
			client,
			'core_calendar_get_action_events_by_courses',
			{
				courseids: courseIds,
				timesortfrom: timestart,
				timesortto: timeend,
				limitnum: 50,
			},
		);
		for (const group of actionData?.groupedbycourse || []) {
			for (const ev of group.events || []) {
				addEvent({ ...ev, courseid: ev.course?.id || group.courseid }, 'action_courses');
			}
		}
	} catch (err) {
		console.warn(
			`[Calendar] core_calendar_get_action_events_by_courses note: ${err.message}`,
		);
	}

	// 3. core_calendar_get_calendar_upcoming_view (includes non-actionable course/lab events!)
	try {
		const upcomingData = await apiCall(
			client,
			'core_calendar_get_calendar_upcoming_view',
			{
				courseid: 1,
			},
		);
		for (const ev of upcomingData?.events || []) {
			addEvent(ev, 'upcoming_view');
		}
	} catch (err) {
		console.warn(
			`[Calendar] core_calendar_get_calendar_upcoming_view note: ${err.message}`,
		);
	}

	// 4. core_calendar_get_calendar_events
	try {
		const calData = await apiCall(client, 'core_calendar_get_calendar_events', {
			events: {
				courseids: courseIds,
			},
			options: {
				userevents: 0,
				siteevents: 0,
				timestart,
				timeend,
			},
		});
		for (const ev of calData?.events || []) {
			addEvent(ev, 'calendar_events');
		}
	} catch {
		// Often restricted to WS token; ignore silently as upcoming_view + HTML cover it
	}

	// 5. HTML fallback: scrape /calendar/view.php?view=upcoming
	try {
		const htmlEvents = await scrapeUpcomingCalendarHtml(client, courseMap);
		for (const ev of htmlEvents) {
			addEvent(ev, 'html_upcoming');
		}
	} catch (err) {
		console.warn(`[Calendar] HTML upcoming calendar fallback failed: ${err.message}`);
	}

	console.log(`[Calendar] Total deduplicated calendar events found: ${events.size}`);
	return Array.from(events.values());
}

/**
 * Scrape /calendar/view.php?view=upcoming for course calendar events
 */
async function scrapeUpcomingCalendarHtml(client, courseMap) {
	const response = await client.request(
		'GET',
		`${client.baseUrl}/calendar/view.php?view=upcoming`,
	);
	const $ = cheerio.load(response.data || '');
	const results = [];

	$('div[data-type="event"], div.event[data-event-id]').each((_, el) => {
		const card = $(el);
		const eventId =
			card.attr('data-event-id') ||
			card.find('[data-event-id]').attr('data-event-id');
		const courseIdAttr =
			card.attr('data-course-id') ||
			card
				.find('a[href*="course/view.php?id="]')
				.attr('href')
				?.match(/[?&]id=(\d+)/)?.[1];

		const courseid = Number(courseIdAttr || 0);
		if (!eventId || !courseid || !courseMap.has(courseid)) return;

		const name =
			card.attr('data-event-title') ||
			card.find('h3.name, .eventname').first().text().trim();
		const modulename = card.attr('data-event-component')?.replace(/^mod_/, '') || 'calendar';
		const descriptionHtml = card.find('.description-content, .description').first().html() || '';

		const actionLink =
			card.find('.card-footer a, a.card-link').attr('href') ||
			card.find('a[href*="/mod/"]').first().attr('href') ||
			'';
		const instanceMatch = actionLink.match(/[?&]id=(\d+)/);
		const instance = instanceMatch ? Number(instanceMatch[1]) : null;

		let timestart = null;
		const timeLink = card.find('a[href*="time="]').attr('href');
		const timeMatch = timeLink?.match(/[?&]time=(\d+)/);
		if (timeMatch) {
			timestart = Number(timeMatch[1]);
		}

		results.push({
			id: Number(eventId),
			name: name || 'Calendar Event',
			description: descriptionHtml,
			courseid,
			modulename,
			instance,
			timestart,
			timeduration: 0,
			url: actionLink,
		});
	});

	return results;
}

/**
 * Scrape a course page for sections, mod/page instructions, and mod/url links.
 * Fetches the body of relevant mod/page activities so instructions & links can be embedded.
 */
export async function getCourseContextForEnrichment(client, course) {
	const response = await client.request(
		'GET',
		`${client.baseUrl}/course/view.php?id=${course.id}`,
	);
	const $ = cheerio.load(response.data || '');

	const sections = [];
	const pagesByModuleId = new Map();
	const urlsByModuleId = new Map();

	$('li.section').each((index, element) => {
		const sec = $(element);
		const secIndexMatch = sec.attr('id')?.match(/section-(\d+)/);
		const sectionNumber = secIndexMatch ? parseInt(secIndexMatch[1], 10) : index;

		const secLink = sec.find('a[href*="section.php"]').first();
		const secUrl = secLink.attr('href') || '';
		const sectionId = secUrl ? extractSectionId(secUrl) : null;
		const name =
			secLink.text().trim() ||
			sec.find('.sectionname').first().text().trim() ||
			`Section ${sectionNumber}`;

		const summaryEl = sec
			.find(
				'.summarytext .no-overflow, .content > .summary .no-overflow, .summary .no-overflow',
			)
			.first();
		const summaryHtml = summaryEl.html() || '';
		const summaryText = normalizeSectionHtml(summaryHtml);
		const summaryLinks = extractLinksFromHtml($, summaryEl, client.baseUrl);

		const { weekStart, weekEnd } = parseWeekDates(name, client.year || 2026);

		const modules = [];
		sec.find('li.activity').each((_, actEl) => {
			const act = $(actEl);
			let modname = null;
			for (const cls of (act.attr('class') || '').split(/\s+/)) {
				if (cls.startsWith('modtype_')) {
					modname = cls.replace('modtype_', '');
					break;
				}
				if (cls.startsWith('modtype-')) {
					modname = cls.replace('modtype-', '');
					break;
				}
			}

			const aalink = act.find('a.aalink').first();
			const url = aalink.attr('href') || '';
			const idMatch = url.match(/[?&]id=(\d+)/);
			const moduleId = idMatch ? Number(idMatch[1]) : null;

			const linkClone = aalink.clone();
			linkClone.find('.accesshide').remove();
			const title =
				linkClone.text().trim() ||
				act.find('.instancename').first().text().trim() ||
				'';

			const descEl =
				modname === 'label'
					? act
							.find(
								'.contentwithoutlink, .activity-altcontent, .no-overflow',
							)
							.first()
					: act
							.find('div.activity-description, .contentafterlink')
							.first();
			const effectiveDescEl = descEl.length ? descEl : modname === 'label' ? act : descEl;
			const descText = normalizeSectionHtml(effectiveDescEl.html() || '');
			const descLinks = extractLinksFromHtml($, effectiveDescEl, client.baseUrl);

			const modObj = {
				id: moduleId,
				modname,
				name: title || (modname === 'label' ? descText.split('\n')[0]?.slice(0, 80) || 'Label' : ''),
				url,
				description: descText,
				links: descLinks,
				sectionId,
				sectionNumber,
				sectionName: name,
			};
			modules.push(modObj);

			if (modname === 'page' && moduleId) {
				pagesByModuleId.set(moduleId, modObj);
			} else if (modname === 'url' && moduleId) {
				urlsByModuleId.set(moduleId, modObj);
			}
		});

		sections.push({
			id: sectionId,
			sectionId,
			sectionNumber,
			name,
			url: secUrl,
			summaryText,
			summaryLinks,
			weekStart,
			weekEnd,
			modules,
		});
	});

	return {
		course,
		sections,
		pagesByModuleId,
		urlsByModuleId,
	};
}

/**
 * Fetch the full content and links inside a mod/page activity (/mod/page/view.php?id=...)
 */
export async function fetchModPageDetail(client, pageUrl) {
	if (!pageUrl) return { text: '', links: [] };
	try {
		const res = await client.request('GET', pageUrl);
		const $ = cheerio.load(res.data || '');
		const mainRegion = $(
			'#region-main .box.generalbox, [role="main"] .generalbox, #region-main',
		).first();
		const text = normalizeSectionHtml(mainRegion.html() || '');
		const links = extractLinksFromHtml($, mainRegion, client.baseUrl);
		return { text, links };
	} catch (err) {
		console.warn(`[Calendar] Could not fetch mod/page ${pageUrl}: ${err.message}`);
		return { text: '', links: [] };
	}
}

function extractLinksFromHtml($, container, baseUrl) {
	if (!container || !container.length) return [];
	const links = [];
	const seen = new Set();

	container.find('a[href]').each((_, a) => {
		const rawHref = $(a).attr('href') || '';
		if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) {
			return;
		}
		let fullUrl = rawHref;
		try {
			fullUrl = new URL(rawHref, baseUrl).href;
		} catch {
			return;
		}
		if (seen.has(fullUrl)) return;
		seen.add(fullUrl);

		const clone = $(a).clone();
		clone.find('.accesshide').remove();
		const label = clone.text().trim() || fullUrl;
		links.push({ label, url: fullUrl });
	});

	return links;
}

/**
 * Build an enriched markdown description for a calendar event or lab task.
 * Includes the event's own description, related mod/page instructions, mod/label content, and mod/url links.
 */
export function enrichCalendarEvent(event, section, pageDetailsMap = new Map()) {
	const parts = [];

	// 1. Event's own description & location
	if (event.location) {
		parts.push(`- **Konum / Lab:** ${event.location}`);
	}
	if (event.description) {
		const cleaned = normalizeSectionHtml(event.description);
		if (cleaned) {
			parts.push(cleaned);
		}
	}

	if (section) {
		// 2. Section summary notes if relevant
		if (section.summaryText && !parts.includes(section.summaryText)) {
			parts.push(`### 📋 Hafta / Bölüm Açıklaması (${section.name})\n\n${section.summaryText}`);
		}

		// 2b. Inline mod/label notes in the section
		const relatedLabels = (section.modules || []).filter(
			(m) => m.modname === 'label' && m.description,
		);
		for (const lbl of relatedLabels) {
			if (!parts.includes(lbl.description)) {
				parts.push(lbl.description);
			}
		}

		// 3. Related mod/page instructions in the same section
		const relatedPages = (section.modules || []).filter((m) => m.modname === 'page');
		if (relatedPages.length > 0) {
			parts.push('### 📄 İlgili Ders / Lab Yönergeleri');
			for (const page of relatedPages) {
				const detail = pageDetailsMap.get(page.id);
				const bodyText = detail?.text || page.description || '';
				parts.push(`#### ${page.name}`);
				if (bodyText) {
					const excerpt =
						bodyText.length > 2500
							? `${bodyText.slice(0, 2500)}\n\n_(Devamı ODTUClass sayfasında)_`
							: bodyText;
					parts.push(excerpt);
				}
				if (page.url) {
					parts.push(`- 🔗 [ODTUClass Sayfasını Aç](${page.url})`);
				}
			}
		}

		// 4. Related mod/url, mod/resource, mod/folder links in the same section
		const linkItems = [];
		const seenUrls = new Set();

		const addLinkItem = (label, url) => {
			if (!url || seenUrls.has(url)) return;
			seenUrls.add(url);
			linkItems.push(`- [${label || url}](${url})`);
		};

		for (const l of section.summaryLinks || []) {
			addLinkItem(l.label, l.url);
		}
		for (const mod of section.modules || []) {
			if (
				mod.modname === 'url' ||
				mod.modname === 'resource' ||
				mod.modname === 'folder'
			) {
				addLinkItem(mod.name, mod.url);
			}
			for (const l of mod.links || []) {
				addLinkItem(l.label, l.url);
			}
			const pageDetail = pageDetailsMap.get(mod.id);
			for (const l of pageDetail?.links || []) {
				addLinkItem(l.label, l.url);
			}
		}

		if (linkItems.length > 0) {
			parts.push(`### 🔗 İlgili Bağlantılar ve Materyaller\n\n${linkItems.join('\n')}`);
		}
	}

	return parts.join('\n\n').trim();
}

/**
 * Match a calendar event to a course section by module instance ID or date range.
 */
export function matchEventToSection(event, sections = []) {
	if (!sections || sections.length === 0) return null;

	// 1. Match by exact module ID if the event belongs to a module in a section
	if (event.instance) {
		for (const sec of sections) {
			for (const mod of sec.modules || []) {
				if (mod.id && Number(mod.id) === Number(event.instance)) {
					return sec;
				}
			}
		}
	}

	// 2. Match by event date falling within section's weekStart..weekEnd
	const ts = event.timestart || event.timesort;
	if (ts) {
		const eventDateStr = new Date(ts * 1000).toISOString().slice(0, 10);
		for (const sec of sections) {
			if (!sec.weekStart || !sec.weekEnd) continue;
			if (eventDateStr >= sec.weekStart && eventDateStr <= sec.weekEnd) {
				return sec;
			}
		}
	}

	return null;
}

/**
 * Filter calendar events to exclude those already captured by the assignments pipeline.
 */
export function filterDuplicateEvents(calendarEvents, existingAssignments = []) {
	const existingModuleIds = new Set();
	const existingCourseTitles = new Set();

	for (const a of existingAssignments) {
		if (a.courseId && a.moduleId) {
			existingModuleIds.add(`${a.courseId}:${a.moduleId}`);
		}
		if (a.courseId && a.title) {
			const normTitle = String(a.title)
				.toLowerCase()
				.replace(/\s+(is\s+due|opens|closes)$/i, '')
				.replace(/[^a-z0-9]+/g, '');
			existingCourseTitles.add(`${a.courseId}:${normTitle}`);
		}
	}

	// 1. First merge paired "opens" / "closes" ("is due") calendar events for the same course + base title
	const mergedByKey = new Map();
	for (const ev of calendarEvents) {
		const courseId = Number(ev.courseid || ev.course?.id || 0);
		const rawName = String(ev.name || '').trim();
		const isOpenEvent =
			ev.eventtype === 'open' || /\bopens$/i.test(rawName);
		const isCloseOrDueEvent =
			ev.eventtype === 'due' ||
			ev.eventtype === 'close' ||
			/\b(?:is\s+due|closes|due)$/i.test(rawName);
		const baseTitle = rawName
			.replace(/\s+(?:is\s+due|opens|closes|due)$/i, '')
			.trim();
		const normBase = baseTitle.toLowerCase().replace(/[^a-z0-9]+/g, '');
		const mergeKey = ev.instance
			? `inst:${courseId}:${ev.instance}`
			: `title:${courseId}:${normBase}`;

		if (!mergedByKey.has(mergeKey)) {
			const clone = { ...ev, name: baseTitle || rawName };
			if (isOpenEvent && ev.timestart) {
				clone._openTimestamp = ev.timestart;
			}
			if (isCloseOrDueEvent && ev.timestart) {
				clone._dueTimestamp = ev.timestart;
			}
			mergedByKey.set(mergeKey, clone);
		} else {
			const existing = mergedByKey.get(mergeKey);
			if (isOpenEvent && ev.timestart) {
				existing._openTimestamp = ev.timestart;
			}
			if (isCloseOrDueEvent && ev.timestart) {
				existing._dueTimestamp = ev.timestart;
				existing.id = ev.id; // Prefer the due event ID
			}
			if (ev.description && !existing.description) {
				existing.description = ev.description;
			}
			if (ev.url && !existing.url) {
				existing.url = ev.url;
			}
		}
	}

	const ADMIN_OR_ROUTINE_REGEX =
		/\b(?:course\s+conflict|section\s+transfer|transfer\s+application|excuse\s+(?:form|application)|make-?up\s+(?:exam\s+)?application)\b/i;

	return Array.from(mergedByKey.values()).filter((ev) => {
		const courseId = Number(ev.courseid || ev.course?.id || 0);
		const modName = String(ev.modulename || '').toLowerCase();
		const cleanName = String(ev.name || '')
			.replace(/\s+(is\s+due|opens|closes|due)$/i, '')
			.trim();

		// Skip routine lecture attendance events and administrative forms
		if (modName === 'attendance' || /\battendance\b/i.test(cleanName)) {
			return false;
		}
		if (ADMIN_OR_ROUTINE_REGEX.test(cleanName)) {
			return false;
		}

		if (courseId && ev.instance && existingModuleIds.has(`${courseId}:${ev.instance}`)) {
			return false;
		}
		const normName = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '');
		if (courseId && normName && existingCourseTitles.has(`${courseId}:${normName}`)) {
			return false;
		}
		return true;
	});
}

/**
 * Convert a calendar event into an assignment-compatible task payload.
 */
export function calendarEventToAssignment(
	event,
	course,
	enrichedDescription,
	section = null,
) {
	const timestart = event.timestart || event.timesort || null;
	const timeduration = Number(event.timeduration || 0);

	let openAt = null;
	let dueAt = null;

	if (event._openTimestamp && event._dueTimestamp) {
		openAt = new Date(event._openTimestamp * 1000).toISOString();
		dueAt = new Date(event._dueTimestamp * 1000).toISOString();
	} else if (timestart) {
		const startIso = new Date(timestart * 1000).toISOString();
		if (timeduration > 0) {
			openAt = startIso;
			dueAt = new Date((timestart + timeduration) * 1000).toISOString();
		} else if (event._openTimestamp && !event._dueTimestamp) {
			openAt = startIso;
		} else {
			dueAt = startIso;
		}
	}

	const cleanTitle = String(event.name || 'Calendar Event')
		.replace(/\s+(?:is\s+due|opens|closes)$/i, '')
		.trim();

	const url =
		event.action?.url ||
		event.url ||
		`${course.url || `https://odtuclass2026f.metu.edu.tr/course/view.php?id=${course.id}`}`;

	const content = enrichedDescription || '';
	const contentHash = computeContentHash(
		`${cleanTitle}|${openAt || ''}|${dueAt || ''}|${content}`,
	);

	return {
		id: `calendar:${course.id}:${event.id}`,
		type: 'assignment',
		courseId: course.id,
		courseName: course.fullname,
		sectionId: section?.sectionId || section?.id || null,
		sectionName: section?.name || null,
		sectionNumber:
			typeof section?.sectionNumber === 'number' ? section.sectionNumber : null,
		weekStart: section?.weekStart || null,
		weekEnd: section?.weekEnd || null,
		moduleId: event.instance || event.id,
		moduleType: event.modulename || 'calendar',
		title: cleanTitle,
		url,
		description: content,
		content,
		contentHash,
		openAt,
		dueAt,
		closeAt: dueAt,
		status: 'todo',
		source: 'calendar',
	};
}

/**
 * High-level pipeline helper: fetches calendar events, scans lab courses for experiment/schedule
 * pages, enriches tasks with course section mod/page instructions and mod/url links,
 * and returns assignment-compatible tasks.
 */
export async function getEnrichedCalendarTasks(
	client,
	courses,
	existingAssignments = [],
) {
	const rawEvents = await getCalendarEvents(client, courses);
	const uniqueEvents = filterDuplicateEvents(rawEvents, existingAssignments);

	const courseMap = new Map(courses.map((c) => [Number(c.id), c]));
	const contextByCourseId = new Map();
	const pageDetailsCache = new Map();

	const ensureCourseContext = async (cid) => {
		if (!contextByCourseId.has(cid) && courseMap.has(cid)) {
			try {
				const ctx = await getCourseContextForEnrichment(client, courseMap.get(cid));
				contextByCourseId.set(cid, ctx);
			} catch (err) {
				console.warn(
					`[Calendar] Failed to load course context for ${cid}: ${err.message}`,
				);
			}
		}
		return contextByCourseId.get(cid);
	};

	// Load course context for courses with calendar events OR lab courses
	for (const ev of uniqueEvents) {
		await ensureCourseContext(Number(ev.courseid));
	}
	for (const course of courses) {
		if (/\blab(s|oratory)?\b/i.test(course.fullname)) {
			const ctx = await ensureCourseContext(Number(course.id));
			if (ctx) {
				const modSummary = ctx.sections.flatMap((s) =>
					(s.modules || []).map(
						(m) =>
							`[sec ${s.sectionNumber}: ${s.name}] ${m.modname}: "${m.name}" (links=${(m.links || []).length}, textLen=${(m.description || '').length})`,
					),
				);
				console.log(
					`[Calendar] Lab course [${course.id}] ${course.fullname}: ${ctx.sections.length} section(s), ${modSummary.length} module(s):`,
				);
				for (const line of modSummary) {
					console.log(`  - ${line}`);
				}
			}
		}
	}

	const tasks = [];

	for (const ev of uniqueEvents) {
		const cid = Number(ev.courseid);
		const course = courseMap.get(cid);
		if (!course) continue;

		const ctx = contextByCourseId.get(cid);
		const matchedSection = ctx ? matchEventToSection(ev, ctx.sections) : null;

		if (matchedSection) {
			for (const mod of matchedSection.modules || []) {
				if (mod.modname === 'page' && mod.id && !pageDetailsCache.has(mod.id)) {
					const detail = await fetchModPageDetail(client, mod.url);
					pageDetailsCache.set(mod.id, detail);
				}
			}
		}

		const enrichedDesc = enrichCalendarEvent(
			ev,
			matchedSection,
			pageDetailsCache,
		);
		const task = calendarEventToAssignment(
			ev,
			course,
			enrichedDesc,
			matchedSection,
		);
		tasks.push(task);
	}

	// Also check Lab courses for experiment/schedule sections or mod/page items
	const existingIdsAndTitles = new Set(
		[...existingAssignments, ...tasks].map((t) =>
			`${t.courseId}:${String(t.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
		),
	);

	for (const course of courses) {
		if (!/\blab(s|oratory)?\b/i.test(course.fullname)) continue;
		const ctx = contextByCourseId.get(Number(course.id));
		if (!ctx) continue;

		for (const sec of ctx.sections || []) {
			if (sec.sectionNumber === 0) continue;
			const isExperimentSection =
				/\b(?:experiment|deney|lab(?:oratory)?\s*schedule|group\s*info|lab\s*\d+)\b/i.test(
					sec.name || '',
				) ||
				(sec.modules || []).some(
					(m) =>
						(m.modname === 'page' || m.modname === 'label') &&
						/\b(?:experiment\s*\d+|deney\s*\d+|lab(?:oratory)?\s*schedule)\b/i.test(
							`${m.name || ''} ${m.description || ''}`,
						),
				);

			if (!isExperimentSection) continue;

			const normSecTitle = String(sec.name || '')
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '');
			if (existingIdsAndTitles.has(`${course.id}:${normSecTitle}`)) continue;

			for (const mod of sec.modules || []) {
				if (mod.modname === 'page' && mod.id && !pageDetailsCache.has(mod.id)) {
					const detail = await fetchModPageDetail(client, mod.url);
					pageDetailsCache.set(mod.id, detail);
				}
			}

			const enrichedDesc = enrichCalendarEvent(
				{ name: sec.name, description: '' },
				sec,
				pageDetailsCache,
			);
			if (!enrichedDesc) continue;

			const contentHash = computeContentHash(
				`${sec.name}|${sec.weekStart || ''}|${sec.weekEnd || ''}|${enrichedDesc}`,
			);
			tasks.push({
				id: `calendar:${course.id}:sec-${sec.sectionId || sec.sectionNumber}`,
				type: 'assignment',
				courseId: course.id,
				courseName: course.fullname,
				sectionId: sec.sectionId || null,
				sectionName: sec.name || null,
				sectionNumber: sec.sectionNumber ?? null,
				weekStart: sec.weekStart || null,
				weekEnd: sec.weekEnd || null,
				moduleId: sec.sectionId || sec.sectionNumber,
				moduleType: 'calendar',
				title: sec.name,
				url:
					sec.url ||
					`https://odtuclass2026f.metu.edu.tr/course/view.php?id=${course.id}`,
				description: enrichedDesc,
				content: enrichedDesc,
				contentHash,
				openAt: sec.weekStart ? `${sec.weekStart}T09:00:00.000Z` : null,
				dueAt: sec.weekEnd ? `${sec.weekEnd}T23:59:00.000Z` : null,
				closeAt: sec.weekEnd ? `${sec.weekEnd}T23:59:00.000Z` : null,
				status: 'todo',
				source: 'calendar_lab',
			});
		}
	}

	return tasks;
}
