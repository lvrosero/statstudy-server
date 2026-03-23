const express  = require('express');
const webpush  = require('web-push');
const cors     = require('cors');
const admin    = require('firebase-admin');

const app = express();
app.use(express.json());
app.use(cors({ origin: ['https://statstudy.web.app', 'https://statstudy.firebaseapp.com'] }));

// ── VAPID ─────────────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:medicoblasthub@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Firebase Admin ────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FB_PROJECT_ID,
    clientEmail: process.env.FB_CLIENT_EMAIL,
    privateKey:  process.env.FB_PRIVATE_KEY.replace(/\\n/g, '\n'),
  })
});
const db = admin.firestore();

// ── Health check ──────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'STATstudy Push Server' }));

// ── Guardar suscripción + preferencias del usuario ────────
app.post('/subscribe', async (req, res) => {
  const { userId, subscription, dailyOn, examOn, notifTime, timezone } = req.body;
  if (!userId || !subscription) return res.status(400).json({ error: 'Faltan datos' });
  try {
    await db.collection('push_subs').doc(userId).set({
      subscription,
      dailyOn:    dailyOn   ?? true,
      examOn:     examOn    ?? false,
      notifTime:  notifTime || '07:00',   // hora local del usuario, ej. "23:00"
      timezone:   timezone  || 'America/Guayaquil',
      updatedAt:  new Date().toISOString()
    }, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Eliminar suscripción ──────────────────────────────────
app.post('/unsubscribe', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Falta userId' });
  try {
    await db.collection('push_subs').doc(userId).delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Enviar a usuarios cuya hora preferida es AHORA ────────
// Este endpoint lo llama cron-job.org CADA HORA
// El servidor filtra quién debe recibir la notif en este momento
app.post('/send-hourly', async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'No autorizado' });

  try {
    const subs = await db.collection('push_subs').where('dailyOn', '==', true).get();
    if (subs.empty) return res.json({ ok: true, sent: 0, checked: 0 });

    const now = new Date();
    const currentUTCHour   = now.getUTCHours();
    const currentUTCMinute = now.getUTCMinutes();

    let checked = 0, sent = 0;
    const promises = subs.docs.map(async doc => {
      const data = doc.data();
      if (!data.notifTime || !data.subscription) return;

      // Convertir la hora preferida del usuario a UTC para comparar
      const [prefHour, prefMinute] = data.notifTime.split(':').map(Number);
      const timezone = data.timezone || 'America/Guayaquil';

      // Calcular la hora UTC equivalente a la hora local preferida del usuario
      let utcHour = prefHour;
      try {
        // Obtener offset de la timezone del usuario
        const userDate = new Date();
        const userTime = new Date(userDate.toLocaleString('en-US', { timeZone: timezone }));
        const utcTime  = new Date(userDate.toLocaleString('en-US', { timeZone: 'UTC' }));
        const offsetHours = Math.round((utcTime - userTime) / 3600000);
        utcHour = (prefHour + offsetHours + 24) % 24;
      } catch (e) {
        // Si falla el timezone, usar offset de Ecuador (-5)
        utcHour = (prefHour + 5 + 24) % 24;
      }

      checked++;
      // Solo enviar si la hora UTC actual coincide con la hora preferida del usuario
      if (currentUTCHour === utcHour && currentUTCMinute < 10) {
        try {
          await webpush.sendNotification(
            data.subscription,
            JSON.stringify({
              title: 'STATstudy — Hora de estudiar 📚',
              body:  'Tu sesión de hoy te espera. ¡Mantén tu racha!'
            })
          );
          sent++;
        } catch (e) {
          // Endpoint inválido — limpiar suscripción
          if (e.statusCode === 410 || e.statusCode === 404) {
            await db.collection('push_subs').doc(doc.id).delete();
          }
        }
      }
    });

    await Promise.allSettled(promises);
    res.json({ ok: true, sent, checked, utcHour: currentUTCHour, utcMin: currentUTCMinute });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Enviar a TODOS (para pruebas o anuncios) ──────────────
app.post('/send-all', async (req, res) => {
  const { title, body, secret } = req.body;
  if (secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'No autorizado' });
  try {
    const subs = await db.collection('push_subs').get();
    const promises = subs.docs.map(doc =>
      webpush.sendNotification(doc.data().subscription, JSON.stringify({ title, body }))
        .catch(async e => {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await db.collection('push_subs').doc(doc.id).delete();
          }
        })
    );
    await Promise.allSettled(promises);
    res.json({ ok: true, total: subs.docs.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`STATstudy Push Server en puerto ${PORT}`));
