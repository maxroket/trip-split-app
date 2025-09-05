const http = require('http');
const fs = require('fs');
const path = require('path');

// Path to persistent data store.  We use a JSON file to keep things simple
const DATA_FILE = path.join(__dirname, 'data.json');

/**
 * Read the current data from disk.  If the file does not exist yet, an
 * initial structure is returned and written to disk.  This function
 * synchronously reads the file to simplify server logic.  Because the
 * application is single‑user (friends on a single instance), the amount of
 * concurrent writes will be minimal and synchronous IO is acceptable.
 */
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // Initialise empty structure if file missing or unreadable
    const initial = { trips: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

/**
 * Write the provided data back to disk.  Uses pretty formatting to
 * simplify debugging.
 */
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/**
 * Generate a simple unique identifier based off the current timestamp and a
 * random component.  IDs are prefixed to indicate their type.
 *
 * @param {string} prefix A short prefix like 'trip', 'p', 'e', 't'
 */
function generateId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;
}

/**
 * Compute the start and end dates for a trip based on its expenses and
 * transfers.  If start or end dates were explicitly set by the user they
 * are kept; otherwise the function derives them from the earliest and
 * latest dates present in expenses and transfers.  Dates are represented
 * as ISO strings (YYYY‑MM‑DD).  If no dated entries exist then null is
 * returned for both values.
 */
function deriveTripDates(trip) {
  // Gather all dates from expenses and transfers
  const dates = [];
  if (Array.isArray(trip.expenses)) {
    trip.expenses.forEach(exp => {
      if (exp.date) dates.push(exp.date);
    });
  }
  if (Array.isArray(trip.transfers)) {
    trip.transfers.forEach(tr => {
      if (tr.date) dates.push(tr.date);
    });
  }
  dates.sort();
  let startDate = trip.start_date;
  let endDate = trip.end_date;
  if (!startDate && dates.length) startDate = dates[0];
  if (!endDate && dates.length) endDate = dates[dates.length - 1];
  return { startDate, endDate };
}

/**
 * Compute net balances for each participant in a trip.  Each participant
 * starts at zero.  For every expense we add the amount to the payer and
 * subtract the share from each participant based on the expense.shares
 * array.  Transfers subtract from the sender and add to the recipient.  The
 * result is an object keyed by participant id whose value is the net
 * balance.  Positive values indicate money owed to the participant, while
 * negative values indicate money that participant owes.
 */
function computeNetBalances(trip) {
  const net = {};
  trip.participants.forEach(p => {
    net[p.id] = 0;
  });
  // Handle expenses
  if (Array.isArray(trip.expenses)) {
    trip.expenses.forEach(exp => {
      // Add amount to payer
      if (net.hasOwnProperty(exp.payer_id)) {
        net[exp.payer_id] += exp.amount;
      }
      // Subtract share from each participant
      if (Array.isArray(exp.shares)) {
        exp.shares.forEach(share => {
          if (net.hasOwnProperty(share.participant_id)) {
            net[share.participant_id] -= share.amount;
          }
        });
      }
    });
  }
  // Handle transfers
  // A transfer represents one participant paying another to settle a debt.
  // Therefore, the payer's net balance should increase (they owe less) and
  // the recipient's net balance should decrease (they are owed less).
  if (Array.isArray(trip.transfers)) {
    trip.transfers.forEach(tr => {
      if (net.hasOwnProperty(tr.from_id)) {
        net[tr.from_id] += tr.amount;
      }
      if (net.hasOwnProperty(tr.to_id)) {
        net[tr.to_id] -= tr.amount;
      }
    });
  }
  return net;
}

/**
 * Compute a pairwise debt matrix from net balances.  The goal is to
 * produce a mapping from debtor -> creditor -> amount.  Only positive
 * entries indicate money owed.  This algorithm greedily matches debtors
 * to creditors to settle balances.  The matrix is keyed first by the
 * debtor participant id and then by creditor id with the amount owed.
 */
function computeDebtMatrix(net) {
  const debtors = [];
  const creditors = [];
  Object.keys(net).forEach(pid => {
    const balance = net[pid];
    if (balance < -1e-6) {
      debtors.push({ id: pid, amount: -balance });
    } else if (balance > 1e-6) {
      creditors.push({ id: pid, amount: balance });
    }
  });
  // Sort to provide deterministic behaviour
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);
  const matrix = {};
  debtors.forEach(d => {
    matrix[d.id] = {};
  });
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const transferAmount = Math.min(debtor.amount, creditor.amount);
    if (!matrix[debtor.id]) matrix[debtor.id] = {};
    matrix[debtor.id][creditor.id] = (matrix[debtor.id][creditor.id] || 0) + transferAmount;
    debtor.amount -= transferAmount;
    creditor.amount -= transferAmount;
    if (debtor.amount < 1e-6) i++;
    if (creditor.amount < 1e-6) j++;
  }
  return matrix;
}

/**
 * Parse the body of an incoming request and return a promise that
 * resolves with the parsed JSON object.  If the body is empty or
 * contains invalid JSON the promise will reject.
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      // Limit body size to 1MB to avoid abuse
      if (body.length > 1e6) {
        req.connection.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Send a JSON response with the given status code and object.
 */
function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(data);
}

/**
 * Serve static files from the public directory.  If the file does not
 * exist, returns false to allow further handling.
 */
function serveStatic(req, res) {
  let urlPath = req.url;
  if (urlPath === '/') {
    urlPath = '/public/index.html';
  } else if (urlPath.startsWith('/trip')) {
    // Serve the same HTML for trip detail pages so the frontend can
    // hydrate based on the URL parameter
    urlPath = '/public/index.html';
  } else if (!urlPath.startsWith('/public/')) {
    return false;
  }
  const filePath = path.join(__dirname, urlPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
    return true;
  } catch (err) {
    return false;
  }
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  try {
    // CORS preflight support
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }
    // Attempt to serve static assets first
    if (serveStatic(req, res)) {
      return;
    }
    // API routing
    const urlParts = req.url.split('?')[0].split('/').filter(Boolean);
    if (urlParts[0] === 'api' && urlParts[1] === 'trips') {
      const data = readData();
      // GET /api/trips
      if (req.method === 'GET' && urlParts.length === 2) {
        // Return summary list of trips with computed dates
        const tripsSummary = data.trips.map(trip => {
          const { startDate, endDate } = deriveTripDates(trip);
          return {
            id: trip.id,
            name: trip.name,
            location: trip.location,
            start_date: startDate,
            end_date: endDate
          };
        });
        sendJson(res, 200, { trips: tripsSummary });
        return;
      }
      // GET /api/trips/:id
      if (req.method === 'GET' && urlParts.length === 3) {
        const tripId = urlParts[2];
        const trip = data.trips.find(t => t.id === tripId);
        if (!trip) {
          sendJson(res, 404, { error: 'Trip not found' });
          return;
        }
        // Compute derived dates and net balances
        const { startDate, endDate } = deriveTripDates(trip);
        const net = computeNetBalances(trip);
        const matrix = computeDebtMatrix(net);
        // Build response
        const detailedTrip = JSON.parse(JSON.stringify(trip));
        detailedTrip.start_date = startDate;
        detailedTrip.end_date = endDate;
        detailedTrip.net_balances = net;
        detailedTrip.debt_matrix = matrix;
        sendJson(res, 200, detailedTrip);
        return;
      }
      // POST /api/trips
      if (req.method === 'POST' && urlParts.length === 2) {
        const body = await parseJsonBody(req);
        if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
          sendJson(res, 400, { error: 'Trip name is required' });
          return;
        }
        const newTrip = {
          id: generateId('trip'),
          name: body.name.trim(),
          location: body.location ? body.location.trim() : '',
          start_date: body.start_date || null,
          end_date: body.end_date || null,
          participants: [],
          expenses: [],
          transfers: []
        };
        data.trips.push(newTrip);
        writeData(data);
        sendJson(res, 201, newTrip);
        return;
      }
      // POST /api/trips/:id/participants
      if (req.method === 'POST' && urlParts.length === 4 && urlParts[3] === 'participants') {
        const tripId = urlParts[2];
        const trip = data.trips.find(t => t.id === tripId);
        if (!trip) {
          sendJson(res, 404, { error: 'Trip not found' });
          return;
        }
        const body = await parseJsonBody(req);
        if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
          sendJson(res, 400, { error: 'Participant name is required' });
          return;
        }
        const newParticipant = {
          id: generateId('p'),
          name: body.name.trim()
        };
        trip.participants.push(newParticipant);
        writeData(data);
        sendJson(res, 201, newParticipant);
        return;
      }
      // POST /api/trips/:id/expenses
      if (req.method === 'POST' && urlParts.length === 4 && urlParts[3] === 'expenses') {
        const tripId = urlParts[2];
        const trip = data.trips.find(t => t.id === tripId);
        if (!trip) {
          sendJson(res, 404, { error: 'Trip not found' });
          return;
        }
        const body = await parseJsonBody(req);
        const requiredFields = ['payer_id', 'amount', 'description'];
        for (const field of requiredFields) {
          if (!body[field]) {
            sendJson(res, 400, { error: `Missing required field: ${field}` });
            return;
          }
        }
        const payer = trip.participants.find(p => p.id === body.payer_id);
        if (!payer) {
          sendJson(res, 400, { error: 'Invalid payer_id' });
          return;
        }
        const amount = parseFloat(body.amount);
        if (isNaN(amount) || amount <= 0) {
          sendJson(res, 400, { error: 'Invalid amount' });
          return;
        }
        const description = body.description.toString().trim();
        const date = body.date || null;
        // Shares: optional array of {participant_id, amount}.  If not provided
        // then split equally among participants
        let shares = [];
        if (Array.isArray(body.shares) && body.shares.length > 0) {
          let totalShare = 0;
          for (const share of body.shares) {
            const participant = trip.participants.find(p => p.id === share.participant_id);
            if (!participant) {
              sendJson(res, 400, { error: 'Invalid participant in shares' });
              return;
            }
            const shareAmount = parseFloat(share.amount);
            if (isNaN(shareAmount) || shareAmount < 0) {
              sendJson(res, 400, { error: 'Invalid share amount' });
              return;
            }
            totalShare += shareAmount;
            shares.push({ participant_id: share.participant_id, amount: shareAmount });
          }
          // Ensure total share equals expense amount within a tiny epsilon
          if (Math.abs(totalShare - amount) > 0.01) {
            sendJson(res, 400, { error: 'Sum of shares must equal total amount' });
            return;
          }
        } else {
          // Even split
          const participantCount = trip.participants.length;
          const equalShare = parseFloat((amount / participantCount).toFixed(2));
          let remainder = amount - equalShare * participantCount;
          trip.participants.forEach((p, idx) => {
            let shareAmount = equalShare;
            // adjust the remainder to ensure total adds up exactly
            if (remainder > 0.001) {
              shareAmount += 0.01;
              remainder -= 0.01;
            }
            shares.push({ participant_id: p.id, amount: shareAmount });
          });
        }
        const newExpense = {
          id: generateId('e'),
          payer_id: payer.id,
          amount: amount,
          description: description,
          date: date,
          shares: shares
        };
        trip.expenses.push(newExpense);
        // Update derived dates if not explicitly set
        const { startDate, endDate } = deriveTripDates(trip);
        if (!trip.start_date) trip.start_date = startDate;
        if (!trip.end_date) trip.end_date = endDate;
        writeData(data);
        sendJson(res, 201, newExpense);
        return;
      }
      // POST /api/trips/:id/transfers
      if (req.method === 'POST' && urlParts.length === 4 && urlParts[3] === 'transfers') {
        const tripId = urlParts[2];
        const trip = data.trips.find(t => t.id === tripId);
        if (!trip) {
          sendJson(res, 404, { error: 'Trip not found' });
          return;
        }
        const body = await parseJsonBody(req);
        const requiredFields = ['from_id', 'to_id', 'amount'];
        for (const field of requiredFields) {
          if (!body[field]) {
            sendJson(res, 400, { error: `Missing required field: ${field}` });
            return;
          }
        }
        const from = trip.participants.find(p => p.id === body.from_id);
        const to = trip.participants.find(p => p.id === body.to_id);
        if (!from || !to) {
          sendJson(res, 400, { error: 'Invalid from_id or to_id' });
          return;
        }
        const amount = parseFloat(body.amount);
        if (isNaN(amount) || amount <= 0) {
          sendJson(res, 400, { error: 'Invalid amount' });
          return;
        }
        const date = body.date || null;
        const newTransfer = {
          id: generateId('t'),
          from_id: from.id,
          to_id: to.id,
          amount: amount,
          date: date
        };
        trip.transfers.push(newTransfer);
        // Update derived dates if not explicitly set
        const { startDate, endDate } = deriveTripDates(trip);
        if (!trip.start_date) trip.start_date = startDate;
        if (!trip.end_date) trip.end_date = endDate;
        writeData(data);
        sendJson(res, 201, newTransfer);
        return;
      }
    }
    // If we reach here, no route matched
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});