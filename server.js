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
      notifTime:  notifTime || '07:00',
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

// ── Helpers ───────────────────────────────────────────────

// Convierte "HH:MM" en minutos totales desde medianoche
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// Obtiene la hora local actual del usuario como minutos desde medianoche
function getUserLocalMinutes(timezone) {
  try {
    const now = new Date();
    const localStr = now.toLocaleString('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    // localStr puede ser "09:25" o "23:05"
    const [h, m] = localStr.split(':').map(Number);
    return h * 60 + m;
  } catch (e) {
    // Fallback: Ecuador es UTC-5
    const utcMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    return (utcMinutes - 300 + 1440) % 1440;
  }
}

// ── Enviar a usuarios cuya hora preferida es AHORA ────────
// Llamado por cron-job.org cada 5 minutos: */5 * * * *
// Ventana de ±4 minutos para no perder notificaciones entre disparos
app.post('/send-hourly', async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'No autorizado' });

  const WINDOW_MINUTES = 4; // ventana de tolerancia en minutos

  try {
    const subs = await db.collection('push_subs').where('dailyOn', '==', true).get();
    if (subs.empty) return res.json({ ok: true, sent: 0, checked: 0 });

    let checked = 0, sent = 0, skipped = 0;

    const promises = subs.docs.map(async doc => {
      const data = doc.data();
      if (!data.notifTime || !data.subscription) return;

      const timezone = data.timezone || 'America/Guayaquil';
      const prefMinutes  = timeToMinutes(data.notifTime);       // minutos preferidos por el usuario
      const localMinutes = getUserLocalMinutes(timezone);        // minutos actuales en su timezone

      checked++;

      // Diferencia circular (por si cruza medianoche)
      const diff = Math.abs(localMinutes - prefMinutes);
      const circularDiff = Math.min(diff, 1440 - diff);

      if (circularDiff <= WINDOW_MINUTES) {
        // Verificar que no se le haya enviado ya hoy (evitar duplicados)
        const todayKey = new Date().toISOString().slice(0, 10); // "2026-03-22"
        if (data.lastSentDate === todayKey) {
          skipped++;
          return; // ya recibió su notif hoy
        }

        try {
          await webpush.sendNotification(
            data.subscription,
            JSON.stringify({
              title: 'STATstudy — Hora de estudiar 📚',
              body:  'Tu sesión de hoy te espera. ¡Mantén tu racha!'
            })
          );
          sent++;
          // Marcar que ya se envió hoy
          await db.collection('push_subs').doc(doc.id).update({ lastSentDate: todayKey });
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            // Suscripción inválida — eliminar
            await db.collection('push_subs').doc(doc.id).delete();
          }
          console.error('[PUSH] Error enviando a', doc.id, e.statusCode, e.message);
        }
      }
    });

    await Promise.allSettled(promises);
    res.json({ ok: true, sent, checked, skipped, window: WINDOW_MINUTES });
  } catch (e) {
    console.error('[SEND-HOURLY]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Enviar a TODOS (pruebas o anuncios) ───────────────────
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
