const fs = require('fs');
const SESSION_FILE = './sessions.json';

function loadSessionsFromDisk() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      console.log('Loaded sessions from disk:', Object.keys(data).length);
      return data;
    }
  } catch (e) { console.error('Error loading sessions:', e.message); }
  return {};
}

function saveSessionsToDisk(data) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Error saving sessions:', e.message); }
}

module.exports = { loadSessionsFromDisk, saveSessionsToDisk };
