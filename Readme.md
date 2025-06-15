# ResultJano - Bulk Exam Result Fetcher

ResultJano is a web application that automates the process of retrieving and merging multiple student exam results from mbmiums.in. It allows users to fetch results for a range of roll numbers, merge them into a single PDF, and download the combined file.

## Live Deployment

**Access the live application at: [https://resultjano-7e1aa2c91bb0.herokuapp.com/](https://resultjano-7e1aa2c91bb0.herokuapp.com/)**

## Features

- Bulk retrieval of exam results by specifying roll number ranges
- Real-time progress tracking with detailed status updates
- Automatic merging of multiple result PDFs into a single document
- PDF preview in the browser
- Comprehensive logging of the retrieval process

## Installation

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/coehemang/ResultJano.git # or  https://github.com/coehemang/ResultJano.git
   cd ResultJano
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create the necessary directories (will be auto-created on first run):
   - `/downloads` - Temporary storage for individual PDFs
   - `/merged` - Storage for combined PDF results
   - `/public` - Static files for the web interface

## Usage

1. Start the server:
   ```bash
   node server.cjs
   ```

2. Open your browser and navigate to:
   ```
   http://localhost:5002
   ```

3. Enter the required information:
   - Start and end roll numbers
   - Academic year
   - Semester
   - Branch
   - Exam type

4. Click "Get Results" to start the retrieval process
5. Monitor progress in real-time through the status panel
6. Once complete, preview and download the merged PDF

## Configuration

The server runs on port 5002 by default. You can change this by setting the PORT environment variable:

```bash
PORT=8080 node server.cjs
```

## Technical Details

### Technologies Used

- **Backend**: Node.js, Express.js
- **Web Automation**: Puppeteer
- **PDF Manipulation**: PDF merging utilities
- **Frontend**: HTML, CSS (Bootstrap), JavaScript

### Project Structure

- `server.cjs` - Express server and main application logic
- `public/` - Frontend files (HTML, CSS, JavaScript)
- `utils/mergePDFs.cjs` - PDF merging utility
- `downloads/` - Temporary storage for downloaded PDFs
- `merged/` - Storage for merged PDF files

## Limitations

- The maximum roll number range is limited to 200 to prevent server overload
- Roll numbers must be from the same branch and semester
- Start and end roll numbers must have the same prefix (first 6 characters)
- **Important**: This tool only works for scraping results from MBM University's result portal (mbmiums.in)

## Authors

This project was developed by:
- **Mayank Aggarwal** (CSE 2027)
- **Hemang Choudhary** (IT 2027)

## License

This project is licensed under the MIT License - see the LICENSE file for details.
