exports.handler = async (event, context) => {
  // सिर्फ POST रिक्वेस्ट अलाउ करें
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { title, message } = body;

    // Netlify की Environment Variables से चाबियाँ उठाएं
    const appId = process.env.ONESIGNAL_APP_ID;
    const apiKey = process.env.ONESIGNAL_REST_API_KEY;

    if (!appId || !apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'OneSignal keys missing' }) };
    }

    // यहाँ हमने 'Targeted' हटाकर सीधे 'Broadcast' कर दिया है
    let payload = {
      app_id: appId,
      headings: { en: title || 'Atari Esports' },
      contents: { en: message || 'New update available!' },
      included_segments: ['Subscribed Users'] 
    };

    // OneSignal API को रिक्वेस्ट भेजें
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, data })
    };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
