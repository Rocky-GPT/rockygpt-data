/** Preserve non-schedule information from the exact pages behind campus hours.
 * Rejected/unbounded schedules remain in the raw capture, not answerable prose.
 */
import { load, type CheerioAPI } from 'cheerio';
import { chunkDocumentText } from '../src/data-v2/document-text';
import { ATHLETICS_HOURS_URL, GENERAL_CAMPUS_HOURS_URL, LIBRARY_HOURS_URL,
  type HoursSourceCapture } from './campus-hours';

interface Section { heading: string; text: string }
const SEPARATOR = '\n@@HOURS_SOURCE_HEADING@@';
const clean = (text: string) => text.replace(/\u00a0/g, ' ').replace(/[–—]/g, '-')
  .replace(/[’]/g, "'").split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

function document(capture: HoursSourceCapture): CheerioAPI {
  const $ = load(capture.html);
  $('script,style,noscript,nav,footer,input,button,select,textarea').remove();
  $('a[href]').each((_, element) => {
    const anchor = $(element), href = anchor.attr('href') || '';
    try {
      const url = new URL(href, capture.sourceUrl);
      if (href && ['http:', 'https:', 'tel:', 'mailto:', 'sms:'].includes(url.protocol)) {
        const label = anchor.text().replace(/\s+/g, ' ').trim();
        anchor.text(`${label} (${url.href})`);
      }
    } catch { /* Non-URL controls are not source links. */ }
  });
  $('br').replaceWith('\n');
  $('p,li,div,tr').append('\n');
  return $;
}

function generalSections(capture: HoursSourceCapture): Section[] {
  const $ = document(capture), main = $('#content-block');
  if (main.length !== 1) throw new Error('Campus-hours source main content is unavailable');
  main.find('h1,h2,h3,h4,h5,h6').each((_, heading) => {
    const text = clean($(heading).text());
    $(heading).replaceWith(`${SEPARATOR}${text}\n`);
  });
  const omittedSchedules = /^(Normal Office Hours:|Center for Student Involvement \(CSI\)|Summer Store Hours:|Normal Store Hours:)$/i;
  return main.text().split(SEPARATOR).map(block => {
    const [heading, ...lines] = clean(block).split('\n');
    return { heading, text: lines.join('\n') };
  }).filter(section => section.heading && section.text && !omittedSchedules.test(section.heading));
}

function librarySections(capture: HoursSourceCapture): Section[] {
  const $ = document(capture), main = $('#left-area');
  if (main.length !== 1) throw new Error('Library-hours source main content is unavailable');
  // Weekly schedules have their own validity/conflict gate. Retain the rest of
  // the page, including access conditions and help contacts, without that gate
  // being bypassed by the source document.
  const notes = clean(main.text()).split('\n').filter(line => !(
    /^(Library Hours|CIRCULATION DESK HOURS|RESEARCH HELP HOURS|GAME LAB HOURS)$/i.test(line)
    || /^(Fall|Spring|Summer|Winter) Semester/i.test(line)
    || /^\([A-Za-z]+\.? \d.*20\d{2}\)$/.test(line)
    || /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:\b|[- &])/i.test(line)
  ));
  const sections: Section[] = notes.length ? [{ heading: 'Library access conditions', text: notes.join('\n') }] : [];
  $('#sidebar .et_pb_widget').each((_, widget) => {
    const heading = clean($(widget).find('h4').first().text());
    if (heading === 'Ask a Librarian') {
      $(widget).find('a').filter((_, link) => /^Chat (Online|Offline|Busy|Away)$/.test(clean($(link).text()))).remove();
      const text = clean($(widget).text()).replace(/^Ask a Librarian\n?/, '');
      if (text) sections.push({ heading, text });
    }
    if (heading === 'Research Help Hours') {
      const text = clean($(widget).text()).split('\n').filter(line => /^If we are offline/i.test(line)).join('\n');
      if (text) sections.push({ heading: 'Research help contact', text });
    }
  });
  return sections;
}

function athleticsSections(capture: HoursSourceCapture): Section[] {
  const $ = document(capture), main = $('.article-content');
  if (main.length !== 1) throw new Error('Athletics-hours source main content is unavailable');
  const lines = clean(main.text()).split('\n');
  return [
    { heading: 'Athletics facility rental', text: lines.filter(line => /^To rent our facility/i.test(line)).join('\n') },
    { heading: 'Athletics inclement-weather notice', text: lines.filter(line => /^If inclement weather/i.test(line)).join('\n') },
  ].filter(section => section.text);
}

export function renderHoursSourceContext(captures: HoursSourceCapture[]): string {
  const parsers: Record<string, (capture: HoursSourceCapture) => Section[]> = {
    [GENERAL_CAMPUS_HOURS_URL]: generalSections,
    [LIBRARY_HOURS_URL]: librarySections,
    [ATHLETICS_HOURS_URL]: athleticsSections,
  };
  let markdown = '# Campus service policies and notices from hours sources\n\n';
  const seen = new Set<string>();
  for (const capture of captures) {
    const parse = parsers[capture.sourceUrl];
    if (!parse || seen.has(capture.sourceUrl) || !Number.isFinite(Date.parse(capture.collectedAt))) {
      throw new Error('Invalid or duplicate campus-hours source capture');
    }
    seen.add(capture.sourceUrl);
    for (const section of parse(capture)) {
      // Repeat the applicability qualifier in every retrieval chunk, including
      // latter portions of long dated FAQ sections.
      const qualifier = 'Published source notice; dates and update statements apply only as written. '
        + 'Capture time does not renew dated guidance or verify current operating hours.';
      const heading = section.heading.replace(/\n/g, ' ');
      for (const part of chunkDocumentText(section.text, 850, 120)) {
        markdown += `## ${heading}\n\n- URL: ${capture.sourceUrl}\n- Collected At: ${capture.collectedAt}\n\n`
          + `${qualifier}\n\n${part}\n\n`;
      }
    }
  }
  return markdown;
}
