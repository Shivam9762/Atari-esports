exports.handler = async (event, context) => {
  // Allow only POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Parse the data sent from the frontend (app)
    const body = JSON.parse(event.body || '{}');
    const { title, message, targetUserId } = body;

    // Get OneSignal keys from Netlify Environment Variables
    const appId = process.env.ONESIGNAL_APP_ID;
    const apiKey = process.env.ONESIGNAL_REST_API_KEY;

    if (!appId || !apiKey) {
      return { 
        statusCode: 500, 
        body: JSON.stringify({ error: 'OneSignal keys missing in Netlify environment variables.' }) 
      };
    }

    // Prepare the payload for OneSignal
    let payload = {
      app_id: appId,
      headings: { en: title || 'Atari Esports' },
      contents: { en: message || 'New update available!' }
    };

    // If sending to a specific user (Targeted)
    if (targetUserId) {
      payload.include_aliases = { external_id: [targetUserId] };
    } else {
      // If sending to everyone (Broadcast)
      payload.included_segments = ['Subscribed Users']; 
    }

    // Send the request to OneSignal API
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return { statusCode: response.status, body: JSON.stringify({ error: data }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, data })
    };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
