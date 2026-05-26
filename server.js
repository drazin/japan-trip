const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'shared-actions.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

function readActions() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { actions: {}, manual: [] };
  }
}

function writeActions(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/state', (req, res) => {
  res.json(readActions());
});

app.post('/api/state', (req, res) => {
  const { actions, manual } = req.body;
  if (!actions) return res.status(400).json({ error: 'Missing actions' });
  writeActions({ actions, manual: manual || [], updated: new Date().toISOString() });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Japan trip dashboard on port ${PORT}`));
