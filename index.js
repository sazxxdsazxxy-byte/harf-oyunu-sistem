const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: 'postgresql://postgres:sTRSGubyMVWWIhnDGMjDznBkNlAJqWsH@shuttle.proxy.rlwy.net:35597/railway',
  ssl: { rejectUnauthorized: false }
});

async function smsSend(telefon, mesaj) {
  try {
    await axios.get('https://api.netgsm.com.tr/sms/send/get', {
      params: {
        usercode: process.env.NETGSM_USER,
        password: process.env.NETGSM_PASS,
        gsmno: telefon,
        message: mesaj,
        msgheader: process.env.NETGSM_HEADER
      }
    });
  } catch (err) {
    console.error('SMS hatasi:', err.message);
  }
}

app.post('/webhook/shopify', async (req, res) => {
  try {
    const siparis = req.body;
    const telefon = siparis.billing_address?.phone || siparis.phone;
    const email = siparis.email;
    const tutar = parseFloat(siparis.total_price);

    if (!telefon || tutar < 250) {
      return res.status(200).json({ mesaj: 'Ana urun degil, atlandi' });
    }

    const mevcutOyun = await pool.query(
      'SELECT * FROM musteri_oyun WHERE musteri_telefon = $1 AND tamamlandi = false',
      [telefon]
    );

    let oyun;
    if (mevcutOyun.rows.length === 0) {
      const kelimeRes = await pool.query('SELECT * FROM kelimeler ORDER BY RANDOM() LIMIT 1');
      const kelime = kelimeRes.rows[0];
      const yeniOyun = await pool.query(
        'INSERT INTO musteri_oyun (musteri_telefon, musteri_email, atanan_kelime) VALUES ($1, $2, $3) RETURNING *',
        [telefon, email, kelime.kelime]
      );
      oyun = yeniOyun.rows[0];
    } else {
      oyun = mevcutOyun.rows[0];
    }

    const alinanHarfler = oyun.alinan_harfler || '';
    const kelime = oyun.atanan_kelime;
    const siradakiIndex = alinanHarfler.length;

    if (siradakiIndex >= kelime.length) {
      return res.status(200).json({ mesaj: 'Kelime zaten tamamlandi' });
    }

    let gonderilecekHarf = kelime[siradakiIndex];
    let yeniHarfler = alinanHarfler + gonderilecekHarf;

    if (kelime.length === 4 && siradakiIndex === 2) {
      yeniHarfler = kelime;
      gonderilecekHarf = kelime[2] + kelime[3];
    }

    await pool.query(
      'UPDATE musteri_oyun SET alinan_harfler = $1 WHERE id = $2',
      [yeniHarfler, oyun.id]
    );

    await pool.query(
      'INSERT INTO siparisler (siparis_id, musteri_telefon, siparis_tutari, ana_urun_mi, harf_gonderildi) VALUES ($1, $2, $3, true, true)',
      [siparis.id.toString(), telefon, tutar]
    );

    const smsMesaj = 'Magazamizdan alisveris yaptiginiz icin tesekkur ederiz! Ugurlu harfiniz: ' + gonderilecekHarf;
    await smsSend(telefon, smsMesaj);

    if (yeniHarfler.length === kelime.length) {
      await pool.query('UPDATE musteri_oyun SET tamamlandi = true WHERE id = $1', [oyun.id]);
    }

    res.status(200).json({ basarili: true });
  } catch (err) {
    console.error('Webhook hatasi:', err);
    res.status(500).json({ hata: err.message });
  }
});

app.post('/kelime-kontrol', async (req, res) => {
  try {
    const { telefon, kelime } = req.body;
    const oyun = await pool.query(
      'SELECT * FROM musteri_oyun WHERE musteri_telefon = $1 AND tamamlandi = true AND odul_kullanildi = false',
      [telefon]
    );

    if (oyun.rows.length === 0) {
      return res.json({ basarili: false, mesaj: 'Gecerli oyun bulunamadi' });
    }

    if (oyun.rows[0].atanan_kelime === kelime.toUpperCase()) {
      await pool.query('UPDATE musteri_oyun SET odul_kullanildi = true WHERE id = $1', [oyun.rows[0].id]);
      res.json({ basarili: true, mesaj: 'Tebrikler! 200 TL ve alti urun ücretsiz!' });
    } else {
      res.json({ basarili: false, mesaj: 'Yanlis kelime!' });
    }
  } catch (err) {
    res.status(500).json({ hata: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ durum: 'Harf oyunu sistemi calisiyor!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Sunucu ' + PORT + ' portunda calisiyor');
});
async function webhookKaydet() {
  try {
    const response = await axios.post(
      'https://serishop-3.myshopify.com/admin/api/2026-04/webhooks.json',
      {
        webhook: {
          topic: 'orders/paid',
          address: 'https://handsome-mindfulness-production.up.railway.app/webhook/shopify',
          format: 'json'
        }
      },
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Webhook kaydedildi:', response.data);
  } catch (err) {
    console.log('Webhook zaten kayitli veya hata:', err.response?.data || err.message);
  }
}

webhookKaydet();
