import express from 'express';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors());

app.post('/api/generate', async (req, res) => {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify(req.body)
    });
    
    if (!response.ok) {
      throw new Error(`Groq API error: ${response.status}`);
    }
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});