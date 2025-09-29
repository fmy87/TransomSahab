
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });

// --- CORS ---
const allowedOrigins = [
  /^https?:\/\/(www\.)?fmy87\.com$/i,
  /^https?:\/\/localhost(?::\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
  /^https?:\/\/.*onrender\.com$/i
];
app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.some((o) => (o instanceof RegExp ? o.test(origin) : o === origin))) {
      return cb(null, true);
    }
    return cb(null, true); // permit for demo; tighten later if needed
  },
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve frontend (so this can be self-hosted too)
app.use(express.static(path.join(__dirname, 'public')));

// ---- Health ----
app.get('/health', (req, res) => res.type('text').send('ok'));

// ========= In-memory stores =========
const flights = new Map(); // key: `${date}|${flightNo}`
const pax = new Map();     // key -> array
const tty = new Map();
const movements = new Map();
const seatLayout = {
  biz: { start: 1, end: 4, letters: "AC DF" },
  eco: { start: 5, end: 35, letters: "ABC DEF" }
};

function keyOf(flightNo, flightDate){
  return `${flightDate}|${String(flightNo||'').toUpperCase()}`;
}
function emit(room, evt, payload){
  io.to(room).emit(evt, payload);
}

// ---- Socket.io rooms by flight
io.on('connection', (socket)=>{
  socket.on('join', ({flightNo, flightDate}) => {
    const k = keyOf(flightNo, flightDate);
    socket.join(k);
  });
});

// ========= Flights =========
app.get('/api/flights', (req, res)=>{
  const date = req.query.date;
  const rows = [];
  for(const [k,v] of flights){
    if(!date || k.startsWith(`${date}|`)) rows.push(v);
  }
  res.json({ flights: rows });
});
app.post('/api/flights', (req, res)=>{
  const { flightNo, flightDate, from, to, aircraftType, tail } = req.body||{};
  if(!flightNo || !flightDate) return res.status(400).json({ error: 'flightNo and flightDate required' });
  const k = keyOf(flightNo, flightDate);
  const row = flights.get(k) || { flightNo, flightDate, from, to, aircraftType, tail, status: 'OPEN' };
  row.flightNo = flightNo; row.flightDate = flightDate;
  row.from = from||row.from; row.to = to||row.to;
  row.aircraftType = aircraftType||row.aircraftType; row.tail = tail||row.tail;
  flights.set(k, row);
  if(!pax.has(k)) pax.set(k, []);
  emit(k, 'flights:changed', { flightNo, flightDate });
  res.json({ ok: true, flight: row });
});
app.post('/api/flights/status', (req, res)=>{
  const { flightNo, flightDate, status } = req.body||{};
  const k = keyOf(flightNo, flightDate);
  const row = flights.get(k);
  if(!row) return res.status(404).json({ error: 'flight not found' });
  row.status = status;
  flights.set(k, row);
  emit(k, 'flights:changed', { flightNo, flightDate, status });
  res.json({ ok: true });
});

// ========= Seat layout =========
app.get('/api/seat-layout', (req, res)=> res.json({ seatLayout }));

// ========= Pax helpers =========
let nextId = 1;
function ensureFlight(flightNo, flightDate){
  const k = keyOf(flightNo, flightDate);
  if(!flights.get(k)){
    flights.set(k, { flightNo, flightDate, status:'OPEN' });
  }
  if(!pax.get(k)) pax.set(k, []);
  return k;
}

// ========= Pax CRUD =========
app.get('/api/pax', (req, res)=>{
  const { flightNo, flightDate } = req.query;
  if(!flightNo || !flightDate) return res.json({ pax: [] });
  const k = ensureFlight(flightNo, flightDate);
  res.json({ pax: pax.get(k) });
});
app.post('/api/pax', (req, res)=>{
  const { flightNo, flightDate, surname, given, pnr, ppNo, seat } = req.body||{};
  if(!flightNo || !flightDate || !surname) return res.status(400).json({ error: 'flightNo, flightDate, surname required' });
  const k = ensureFlight(flightNo, flightDate);
  const seq = String((pax.get(k).length+1)).padStart(3,'0');
  pax.get(k).push({ id:String(nextId++), flightNo, flightDate, surname, given, pnr, ppNo, seat, status:'OPEN', seq, bagCount:0 });
  emit(k, 'pax:created', {});
  res.json({ ok: true });
});
app.post('/api/pax/search', (req, res)=>{
  const { flightNo, flightDate, q } = req.body||{};
  const k = ensureFlight(flightNo, flightDate);
  const hay = (q||'').toUpperCase();
  const rows = pax.get(k).filter(r=>(
    (r.surname||'').includes(hay) ||
    (r.given||'').includes(hay) ||
    (r.seat||'').toUpperCase().includes(hay) ||
    (r.seq||'').toUpperCase().includes(hay) ||
    (r.pnr||'').toUpperCase().includes(hay)
  ));
  res.json({ pax: rows });
});

// ========= Check-in / Board / Offload =========
app.get('/api/pax/:id/canCheckIn', (req, res)=> res.json({ allowed: true, missing: [] }));
app.post('/api/pax/:id/checkin', (req, res)=>{
  const { id } = req.params;
  for(const [k, arr] of pax){
    const r = arr.find(x=>x.id===id);
    if(r){
      const f = flights.get(k);
      if(f?.status==='PD') return res.status(400).json({ error: 'Flight in PD' });
      r.status='CHECKED';
      emit(k, 'pax:updated', r);
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error:'not found' });
});
app.post('/api/pax/:id/board', (req, res)=>{
  const { id } = req.params;
  for(const [k, arr] of pax){
    const r = arr.find(x=>x.id===id);
    if(r){
      r.status='BOARDED'; r.boarded=true;
      emit(k, 'pax:updated', r);
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error:'not found' });
});
app.post('/api/pax/:id/offload', (req, res)=>{
  const { id } = req.params;
  for(const [k, arr] of pax){
    const r = arr.find(x=>x.id===id);
    if(r){
      r.status='OPEN'; r.boarded=false; r.seat='';
      emit(k, 'pax:updated', r);
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error:'not found' });
});

// ========= Baggage =========
app.post('/api/bags', (req, res)=>{
  const { paxId, count=0, totalWeight=0, manualTag } = req.body||{};
  for(const [k, arr] of pax){
    const r = arr.find(x=>x.id===paxId);
    if(r){
      r.bagCount = (r.bagCount||0) + Number(count||0);
      emit(k, 'pax:updated', r);
      return res.json({ ok:true, pax: r });
    }
  }
  res.status(404).json({ error:'not found' });
});

// ========= Printing (stub) =========
app.post('/api/print/zpl/bp', (req, res)=> res.json({ ok:true }));
app.post('/api/print/zpl/bt', (req, res)=> res.json({ ok:true }));

// ========= PNL upload (simple CSV) =========
app.post('/api/pnl', upload.single('file'), (req, res)=>{
  try{
    const { flightNo, flightDate } = req.body||{};
    const k = ensureFlight(flightNo, flightDate);
    const text = req.file.buffer.toString('utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    let imported = 0;
    for(const line of lines){
      const parts = line.split(',').map(s=>s.trim());
      if(parts.length < 2) continue;
      const surname = (parts[0]||'').toUpperCase();
      const given = (parts[1]||'').toUpperCase();
      const seat = parts[2]||'';
      const pnr = parts[3]||'';
      const seq = String((pax.get(k).length+1)).padStart(3,'0');
      pax.get(k).push({ id:String(nextId++), flightNo, flightDate, surname, given, pnr, seat, status:'OPEN', seq, bagCount:0 });
      imported++;
    }
    emit(k, 'pax:created', { imported });
    res.json({ ok:true, imported });
  }catch(e){
    res.status(400).json({ error: 'parse failed' });
  }
});

// ========= Specials =========
app.get('/api/specials', (req, res)=>{
  const { flightNo, flightDate, k } = req.query||{};
  const key = keyOf(flightNo, flightDate);
  const rows = pax.get(key)||[];
  let items = [];
  switch((k||'').toLowerCase()){
    case 'bags': items = rows.filter(r=>(r.bagCount||0)>0); break;
    case 'infants': items = rows.filter(r=>r.isInfant); break;
    case 'comments': items = rows.filter(r=>r.comment); break;
    default: items = rows;
  }
  res.json({ items });
});

// ========= TTY & Movement =========
app.get('/api/tty', (req, res)=>{
  const { flightNo, flightDate } = req.query||{};
  const k = keyOf(flightNo, flightDate);
  res.json({ items: tty.get(k)||[] });
});
app.post('/api/movement', (req, res)=>{
  const { flightNo, flightDate, off, atd, ata, remark } = req.body||{};
  const k = keyOf(flightNo, flightDate);
  const arr = movements.get(k)||[];
  const row = { off, atd, ata, remark, ts: new Date().toISOString() };
  arr.push(row);
  movements.set(k, arr);
  emit(k, 'movement:new', row);
  res.json({ ok:true });
});

// ========= Assets (stub) =========
app.get('/api/bcbp', (req, res)=>{
  // 1x1 PNG placeholder
  const png1 = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000","hex");
  const rest = Buffer.from("1f15c4890000000a49444154789c6360000002000100ffff03000006000557bf0000000049454e44ae426082","hex");
  res.setHeader('Content-Type', 'image/png');
  res.send(Buffer.concat([png1, rest]));
});
app.get('/api/pax/:id/bp.pdf', (req, res)=>{
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 50 100 Td (Boarding Pass PDF placeholder) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000010 00000 n \n0000000053 00000 n \n0000000106 00000 n \n0000000203 00000 n \ntrailer<</Root 1 0 R/Size 5>>\nstartxref\n300\n%%EOF','utf8');
  res.setHeader('Content-Type', 'application/pdf');
  res.send(pdf);
});

// ---- Start ----
const PORT = process.env.PORT || 4000;
server.listen(PORT, ()=> console.log('TransomSahab listening on', PORT));
