// Shared applications.xlsx column schema — used by tracker.mjs (writes the
// sheets) and webapp/server.mjs (reads/edits them) so the two never drift
// apart on column keys, headers, or which fields are user-owned.
export const COLUMNS = [
  { header: 'Status', key: 'status', width: 14 },
  { header: 'Company', key: 'company', width: 24 },
  { header: 'Role', key: 'title', width: 46 },
  { header: 'Score', key: 'score', width: 8 },
  { header: 'Location', key: 'location', width: 30 },
  { header: 'Source', key: 'source', width: 12 },
  { header: 'Resume', key: 'resumeFile', width: 14 },
  { header: 'Cover Letter', key: 'coverFile', width: 14 },
  { header: 'ATS Match', key: 'atsMatch', width: 11 },
  { header: 'First Seen', key: 'firstSeen', width: 12 },
  { header: 'Last Seen', key: 'lastSeen', width: 12 },
  { header: 'Applied On', key: 'appliedOn', width: 12 },
  { header: 'Notes', key: 'notes', width: 40 },
  { header: 'URL', key: 'url', width: 60 },
];

// Columns the user edits by hand — the tracker never overwrites these on a
// re-run, and the dashboard is the only thing allowed to PATCH them.
export const USER_OWNED = new Set(['status', 'appliedOn', 'notes']);

export const STATUS_VALUES = ['discovered', 'prepared', 'applied', 'interview', 'offer', 'rejected', 'closed'];

export const STATUS_FILL = {
  discovered: 'FFF2F2F2',
  prepared: 'FFFFF3CD',
  applied: 'FFD1E7DD',
  interview: 'FFCFE2FF',
  offer: 'FFD4EDDA',
  rejected: 'FFF8D7DA',
  closed: 'FFE9ECEF',
};

export const TRACKED_SHEETS = ['Applications', 'Internships', 'India Market'];
