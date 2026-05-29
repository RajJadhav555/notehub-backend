-- Enable the vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create the table for storing embeddings
CREATE TABLE IF NOT EXISTS note_embeddings (
    id SERIAL PRIMARY KEY,
    note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT,
    embedding vector(768),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create an index for faster similarity search (IVFFlat)
-- Note: IVFFlat requires some data to be effective, usually created after loading data,
-- but HNSW is better for general cases if supported, or just no index for small datasets.
-- We'll start without an index or a basic one. 

-- Optional: Create an index (might fail if table is empty, so often better to do this later or use HNSW)
-- CREATE INDEX ON note_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
