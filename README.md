---
title: Notehub Backend
emoji: 📘
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# NoteHub Backend API (Hugging Face Space)

This is the Node.js / Express backend service for NoteHub, configured to run as a Docker container on Hugging Face Spaces.

## Hugging Face Configuration
* **SDK:** Docker
* **Port:** 7860 (Set via `app_port` in metadata)

## Setup Secrets
In your Hugging Face Space settings, add the following variables under **Variables and Secrets**:
* `DATABASE_URL` (Supabase Connection URI)
* `JWT_SECRET` (e.g. `j2a43nU8j7q3I2nMV9iEAliwJvI3qo5ZC7BCNCHyoG0=`)
* `GOOGLE_CLIENT_ID`
* `GOOGLE_API_KEY` (Gemini Key)
* `SUPABASE_URL`
* `SUPABASE_KEY`
* `CORS_ORIGIN` (Set to your Vercel URL later)
