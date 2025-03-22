# PubMed Papers Finder - Backend API

A Node.js Express API that searches PubMed for research papers with authors affiliated with pharmaceutical or biotech companies.

## Features

- Search PubMed for research papers with specific keywords
- Filter results to papers with authors from pharmaceutical/biotech companies
- Identify non-academic authors and their company affiliations
- Extract corresponding email addresses when available
- Store search history and results in SQLite database
- Generate and download results as CSV files

## Tech Stack

- **Node.js** - JavaScript runtime
- **Express** - Web framework
- **SQLite3** - Lightweight database
- **node-fetch** - HTTP client
- **xml2js** - XML parsing library
- **csv-writer** - CSV generation

## API Endpoints

- `GET /api/papers?query=SEARCH_TERM` - Search for papers with the given query
- `POST /api/papers/download` - Download search results as CSV
- `GET /health` - Health check endpoint

## Setup and Installation

### Prerequisites

- Node.js (v14+)
- npm or yarn

### Installation

1. Clone the repository:
   ```
   git clone https://github.com/aditya93941/PubMed_Papers_Finder_Backend.git
   cd PubMed_Papers_Finder_Backend
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Run the server:
   ```
   npm start
   ```

The server will start on port 3001 by default (http://localhost:3001).

## Development

To run in development mode with hot-reloading:

```
npm run dev
```

## Database

The application uses SQLite with the following schema:

- **search_history** - Stores search queries and timestamps
- **papers** - Stores paper details (PubMed ID, title, publication date)
- **authors** - Stores author information with company affiliations

The database file is created automatically at `./database.sqlite` when the application starts.

## How It Works

1. The API accepts search queries for PubMed papers
2. It uses NCBI's E-utilities API to search for papers
3. Results are parsed to identify non-academic authors from pharmaceutical/biotech companies
4. Results are filtered to only include papers with at least one non-academic author
5. The data is stored in the SQLite database
6. Results can be downloaded as CSV files

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the ISC License. 