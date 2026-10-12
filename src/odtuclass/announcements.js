import * as cheerio from 'cheerio';

/**
 * Scrapes course announcement forums (mod/forum) for recent discussion threads.
 * Returned items are marked with `isTask: false` and `notificationCategory: 'announcement'`
 * so they trigger ntfy notifications (when enabled) without creating DotPM tasks.
 */
export async function getCourseAnnouncements(client, courses) {
	const announcements = [];

	for (const course of courses) {
		try {
			const courseRes = await client.request(
				'GET',
				`${client.baseUrl}/course/view.php?id=${course.id}`,
			);
			const $ = cheerio.load(courseRes.data);

			const forumLinks = [];
			$('li.activity.modtype_forum, li.activity.modtype-forum').each((_, el) => {
				const act = $(el);
				const link = act.find('a.aalink, a[href*="/mod/forum/view.php"]').first();
				if (!link.length) return;
				const href = link.attr('href') || '';
				const clone = link.clone();
				clone.find('.accesshide').remove();
				const forumName = clone.text().trim() || 'Announcements';
				if (href) {
					forumLinks.push({ href, forumName });
				}
			});

			for (const forum of forumLinks) {
				try {
					const forumRes = await client.request('GET', forum.href);
					const $f = cheerio.load(forumRes.data);

					$f('a[href*="/mod/forum/discuss.php"]').each((_, aEl) => {
						const a = $f(aEl);
						const href = a.attr('href') || '';
						const dMatch = href.match(/[?&]d=(\d+)/);
						if (!dMatch) return;

						// Skip pagination or reply count links
						if (/[?&]parent=/.test(href) || /^(\d+|unread)$/i.test(a.text().trim())) {
							return;
						}

						const discussionId = dMatch[1];
						const subject = a.text().replace(/\s+/g, ' ').trim();
						if (!subject || subject.length < 2) return;

						const itemId = `announcement:${course.id}:forum-${discussionId}`;
						if (announcements.some((x) => x.id === itemId)) return;

						announcements.push({
							id: itemId,
							type: 'assignment',
							source: 'announcement',
							isTask: false,
							notificationCategory: 'announcement',
							courseId: course.id,
							courseName: course.fullname,
							moduleId: `forum-${discussionId}`,
							moduleType: 'forum',
							title: subject,
							url: href.split('#')[0],
							openAt: null,
							dueAt: null,
							closeAt: null,
							status: 'todo',
						});
					});
				} catch (forumErr) {
					console.warn(
						`[Announcements] Could not read forum ${forum.href} for course ${course.id}: ${forumErr.message}`,
					);
				}
			}
		} catch (err) {
			console.warn(
				`[Announcements] Could not check forums for course ${course.id}: ${err.message}`,
			);
		}
	}

	return announcements;
}
