const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { mergePDFs } = require('./utils/mergePDFs.cjs');

const app = express();
const PORT = process.env.PORT || 5002;

// Add queue system variables
const jobQueue = [];
let isProcessing = false;

// Detect Heroku environment
const isHeroku = process.env.DYNO ? true : false;
console.log(`Running in ${isHeroku ? 'Heroku' : 'local'} environment`);

// Adjust resource usage based on environment
const MAX_CONCURRENT_WORKERS = isHeroku ? 1 : 3; // Only use 1 worker on Heroku
const MAX_BATCH_SIZE = isHeroku ? 20 : 50; // Smaller batches on Heroku
const PROTOCOL_TIMEOUT = isHeroku ? 60000 : 30000; // Longer timeout on Heroku

console.log('Initializing server...');
const downloadsBaseDir = path.join(__dirname, 'downloads');
const mergedDir = path.join(__dirname, 'merged');
const publicDir = path.join(__dirname, 'public');

[downloadsBaseDir, mergedDir, publicDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    console.log(`Creating directory: ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use(cors());
app.use(express.json());
app.use('/merged', express.static(mergedDir));
app.use(express.static(publicDir));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const jobStore = {};

const getJobDownloadDir = (jobId) => {
  return path.join(downloadsBaseDir, `job_${jobId}`);
};

const ensureJobDir = async (jobId) => {
  const jobDir = getJobDownloadDir(jobId);
  if (!fs.existsSync(jobDir)) {
    console.log(`Creating job directory: ${jobDir}`);
    fs.mkdirSync(jobDir, { recursive: true });
  }
  return jobDir;
};

const cleanFolder = async folder => {
  if (!fs.existsSync(folder)) {
    console.log(`Folder doesn't exist, skipping cleanup: ${folder}`);
    return;
  }
  
  console.log(`Cleaning folder: ${folder}`);
  const files = await fs.promises.readdir(folder);
  console.log(`Found ${files.length} files to clean`);
  await Promise.all(files.map(file => fs.promises.unlink(path.join(folder, file))));
  console.log(`Folder ${folder} cleaned successfully`);
};

const deleteJobFolder = async (jobId) => {
  const jobDir = getJobDownloadDir(jobId);
  if (fs.existsSync(jobDir)) {
    console.log(`Deleting job folder: ${jobDir}`);
    await fs.promises.rm(jobDir, { recursive: true, force: true });
    console.log(`Job folder deleted: ${jobDir}`);
  }
};

const toRomanNumeral = num => {
  const romanNumerals = { 1: 'Ist', 2: 'IInd', 3: 'IIIrd', 4: 'IVth', 5: 'Vth', 6: 'VIth', 7: 'VIIth', 8: 'VIIIth' };
  return romanNumerals[num] || num.toString();
};

const createBrowser = async () => {
  console.log('Launching Puppeteer browser');
  return await puppeteer.launch({ 
    headless: true,
    protocolTimeout: PROTOCOL_TIMEOUT, // Add protocol timeout to prevent timeouts
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=800,600', // Smaller window size
      '--single-process', // Better for Heroku
      '--disable-extensions',
      '--disable-features=AudioServiceOutOfProcess',
      '--disable-software-rasterizer'
    ]
  });
};

const processRolls = async (browser, rolls, websiteURL, semesterType, academicYear, romanSemester, branch, jobId) => {
  console.log(`Processing ${rolls.length} roll numbers with ${MAX_CONCURRENT_WORKERS} workers`);
  const results = {};
  const jobDir = getJobDownloadDir(jobId);
  
  // Reduce batch size and concurrency for Heroku
  const CONCURRENT_WORKERS = MAX_CONCURRENT_WORKERS;
  const BATCH_SIZE = Math.min(MAX_BATCH_SIZE, rolls.length);
  
  console.log(`Using ${CONCURRENT_WORKERS} concurrent workers with batch size ${BATCH_SIZE}`);
  
  try {
    for (let batchStart = 0; batchStart < rolls.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, rolls.length);
      console.log(`Processing batch from index ${batchStart} to ${batchEnd-1}`);
      
      const batchRolls = rolls.slice(batchStart, batchEnd);
      let currentIndex = 0;
      
      // If browser disconnected, try to reconnect
      if (!browser.isConnected()) {
        console.log('Browser disconnected, creating new browser instance');
        try {
          await browser.close().catch(e => console.log('Error closing disconnected browser:', e));
        } catch (e) {
          console.log('Error during browser cleanup:', e);
        }
        browser = await createBrowser();
      }
      
      const workers = Array.from({ length: CONCURRENT_WORKERS }, async (_, workerIndex) => {
        let page = null;
        let retries = 0;
        const MAX_RETRIES = 3;
        
        while (retries < MAX_RETRIES && !page) {
          try {
            page = await browser.newPage();
            console.log(`Worker ${workerIndex+1}: Created new page (attempt ${retries + 1})`);
          } catch (err) {
            retries++;
            console.error(`Worker ${workerIndex+1}: Failed to create page (attempt ${retries}):`, err);
            await delay(1000 * retries); // Increasing delay between retries
            
            if (retries >= MAX_RETRIES) {
              throw new Error(`Failed to create page after ${MAX_RETRIES} attempts`);
            }
          }
        }
        
        try {
          // Optimize memory usage
          await page.setRequestInterception(true);
          page.on('request', request => {
            const resourceType = request.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
              request.abort();
            } else {
              request.continue();
            }
          });
          
          // Set up dialog handler
          page._dialogShown = false;
          page.on('dialog', async dialog => {
            try {
              console.log(`Worker ${workerIndex+1}: Dialog detected: "${dialog.message()}"`);
              page._dialogShown = true;
              await dialog.accept().catch(err => {
                console.log(`Worker ${workerIndex+1}: Dialog handling note: ${err.message}`);
              });
            } catch (err) {
              console.log(`Worker ${workerIndex+1}: Error handling dialog: ${err.message}`);
            }
          });
          
          // Set download behavior
          const client = await page.target().createCDPSession();
          await client.send('Page.setDownloadBehavior', { 
            behavior: 'allow', 
            downloadPath: jobDir 
          });

          console.log(`Worker ${workerIndex+1}: Navigating to ${websiteURL}`);
          await page.goto(websiteURL, { 
            waitUntil: 'domcontentloaded',
            timeout: 30000 // Increase timeout for initial navigation
          });
          
          console.log(`Worker ${workerIndex+1}: Clicking ${semesterType}Sem${academicYear}`);
          await page.click(`#link${semesterType}Sem${academicYear}`).catch(e => {
            console.error(`Worker ${workerIndex+1}: Error clicking semester link:`, e);
          });
          
          await page.waitForNavigation({ 
            waitUntil: 'networkidle2', 
            timeout: 30000 
          }).catch(() => {
            console.log(`Worker ${workerIndex+1}: Navigation timeout after clicking semester, continuing anyway`);
          });
          
          // Find and click semester and branch link
          console.log(`Worker ${workerIndex+1}: Looking for link with ${romanSemester} and ${branch}`);
          const clicked = await page.evaluate((romanSem, branchName) => {
            const links = Array.from(document.querySelectorAll('a'));
            for (const link of links) {
              if (link.textContent.toLowerCase().includes(romanSem.toLowerCase()) && 
                  link.textContent.toLowerCase().includes(branchName.toLowerCase())) {
                link.click(); 
                return true;
              }
            }
            return false;
          }, romanSemester, branch);

          if (!clicked) {
            console.log(`Worker ${workerIndex+1}: Failed to find link for ${romanSemester} semester and ${branch}`);
            throw new Error(`Could not find link for ${romanSemester} semester and ${branch}`);
          }

          await page.waitForSelector('#txtRollNo', { timeout: 30000 }).catch(() => {
            console.log(`Worker ${workerIndex+1}: Timeout waiting for roll number input, trying to proceed anyway`);
          });
          
          // Process rolls assigned to this worker
          while (true) {
            const rollIndex = currentIndex++;
            if (rollIndex >= batchRolls.length) break;
            
            const roll = batchRolls[rollIndex];
            jobStore[jobId].lastProcessedRoll = roll;
            console.log(`Worker ${workerIndex+1}: Processing roll ${roll} (${batchStart + rollIndex + 1}/${rolls.length})`);
            
            try {
              page._dialogShown = false;
              
              // Clear and enter roll number (with retry)
              let inputSet = false;
              for (let attempt = 0; attempt < 3 && !inputSet; attempt++) {
                try {
                  await page.evaluate(() => document.querySelector('#txtRollNo').value = '');
                  await page.type('#txtRollNo', roll);
                  inputSet = true;
                } catch (err) {
                  console.log(`Worker ${workerIndex+1}: Error setting input (attempt ${attempt+1}):`, err);
                  await delay(1000);
                }
              }
              
              if (!inputSet) {
                throw new Error(`Failed to set roll number input for ${roll}`);
              }
              
              // Click button with safety checks
              try {
                await page.click('#btnGetResult');
              } catch (clickErr) {
                console.error(`Worker ${workerIndex+1}: Error clicking button:`, clickErr);
                throw clickErr;
              }
              
              // Wait to see if dialog appears
              await delay(1500);
              
              // Check for result
              let success = false;
              
              if (!page._dialogShown) {
                // Look for PDF files
                const startTime = Date.now();
                const checkInterval = 200;
                const maxWaitTime = 5000; // Increased timeout for PDF detection
                
                while (Date.now() - startTime < maxWaitTime) {
                  await delay(checkInterval);
                  const files = await fs.promises.readdir(jobDir);
                  const pdfFiles = files.filter(f => f.endsWith('.pdf'));
                  if (pdfFiles.length > 0) {
                    success = true;
                    break;
                  }
                }
              }
              
              // Update job status
              results[roll] = success;
              jobStore[jobId].completed++;
              
              if (success) {
                console.log(`Worker ${workerIndex+1}: Success for roll ${roll}`);
                jobStore[jobId].successful.push(roll);
              } else {
                console.log(`Worker ${workerIndex+1}: No result for roll ${roll} ${page._dialogShown ? '(dialog shown)' : '(no download)'}`);
                jobStore[jobId].notFound.push(roll);
              }
              
              console.log(`Progress: ${jobStore[jobId].completed}/${jobStore[jobId].total} rolls processed`);
              
              // Delay between rolls to prevent rate limiting
              await delay(1000); // Increased delay between rolls for Heroku
              
            } catch (error) {
              console.error(`Worker ${workerIndex+1}: Error processing roll ${roll}:`, error);
              jobStore[jobId].notFound.push(roll);
              jobStore[jobId].completed++;
              
              // Try to reload page after error
              try {
                console.log(`Worker ${workerIndex+1}: Reloading page after error`);
                await page.goto(websiteURL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.click(`#link${semesterType}Sem${academicYear}`);
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                
                console.log(`Worker ${workerIndex+1}: Re-finding semester and branch link`);
                await page.evaluate((romanSem, branchName) => {
                  const links = Array.from(document.querySelectorAll('a'));
                  for (const link of links) {
                    if (link.textContent.toLowerCase().includes(romanSem.toLowerCase()) && 
                        link.textContent.toLowerCase().includes(branchName.toLowerCase())) {
                      link.click(); 
                      return true;
                    }
                  }
                  return false;
                }, romanSemester, branch);
                
                await page.waitForSelector('#txtRollNo', { timeout: 30000 }).catch(() => {});
              } catch (navigationError) {
                console.error(`Worker ${workerIndex+1}: Failed to reload page after error:`, navigationError);
                
                // If page recovery fails, create a new page
                try {
                  console.log(`Worker ${workerIndex+1}: Creating new page after navigation failure`);
                  await page.close().catch(e => console.log('Error closing page:', e));
                  
                  // Create new page with retries
                  for (let pageRetry = 0; pageRetry < 3; pageRetry++) {
                    try {
                      page = await browser.newPage();
                      break;
                    } catch (pageErr) {
                      console.log(`Worker ${workerIndex+1}: Failed to create new page (attempt ${pageRetry+1}):`, pageErr);
                      await delay(1000);
                    }
                  }
                  
                  if (!page) {
                    throw new Error('Could not create new page after multiple attempts');
                  }
                  
                  // Set up the new page
                  await page.setRequestInterception(true);
                  page.on('request', request => {
                    const resourceType = request.resourceType();
                    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                      request.abort();
                    } else {
                      request.continue();
                    }
                  });
                  
                  page._dialogShown = false;
                  page.on('dialog', async dialog => {
                    try {
                      console.log(`Worker ${workerIndex+1}: Dialog detected: "${dialog.message()}"`);
                      page._dialogShown = true;
                      await dialog.accept().catch(err => {
                        console.log(`Worker ${workerIndex+1}: Dialog handling note: ${err.message}`);
                      });
                    } catch (err) {
                      console.log(`Worker ${workerIndex+1}: Error handling dialog: ${err.message}`);
                    }
                  });
                  
                  // Navigate to site and set up for processing
                  await page.goto(websiteURL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                  await page.click(`#link${semesterType}Sem${academicYear}`);
                  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                  
                  await page.evaluate((romanSem, branchName) => {
                    const links = Array.from(document.querySelectorAll('a'));
                    for (const link of links) {
                      if (link.textContent.toLowerCase().includes(romanSem.toLowerCase()) && 
                          link.textContent.toLowerCase().includes(branchName.toLowerCase())) {
                        link.click(); 
                        return true;
                      }
                    }
                    return false;
                  }, romanSemester, branch);
                  
                  await page.waitForSelector('#txtRollNo', { timeout: 30000 }).catch(() => {});
                  
                } catch (recoveryErr) {
                  console.error(`Worker ${workerIndex+1}: Failed to recover:`, recoveryErr);
                  break; // Stop processing this batch of rolls
                }
              }
            }
          }
        } catch (err) {
          console.error(`Worker ${workerIndex+1}: Fatal error:`, err);
        } finally {
          if (page) {
            console.log(`Worker ${workerIndex+1}: Closing page`);
            page.removeAllListeners();
            await page.close().catch(e => console.log('Error closing page:', e));
          }
        }
      });
      
      // Wait for all workers to finish this batch
      await Promise.all(workers);
      console.log(`Completed batch from index ${batchStart} to ${batchEnd-1}`);
      
      // Add a small delay between batches
      if (batchStart + BATCH_SIZE < rolls.length) {
        console.log('Taking a short break between batches to conserve resources');
        await delay(3000);
      }
    }
  } catch (err) {
    console.error(`Error in batch processing:`, err);
  }
  
  return results;
};

const processNextQueuedJob = async () => {
  if (jobQueue.length === 0 || isProcessing) {
    return;
  }
  
  isProcessing = true;
  const jobId = jobQueue.shift();
  console.log(`Starting processing of queued job: ${jobId}`);
  
  jobQueue.forEach((queuedJobId, index) => {
    if (jobStore[queuedJobId]) {
      jobStore[queuedJobId].queuePosition = index + 1;
    }
  });
  
  try {
    const job = jobStore[jobId];
    if (!job || job.status !== 'queued') {
      console.log(`Job ${jobId} is not in queued status, skipping`);
      isProcessing = false;
      processNextQueuedJob();
      return;
    }
    
    job.status = 'pending';
    job.currentStep = 'initializing';
    job.queuePosition = 0; 
    
    const { startRoll, endRoll, academicYear, semester, semesterType, branch } = job.config;
    
    const jobDir = await ensureJobDir(jobId);
    console.log(`Using job directory: ${jobDir}`);
    
    const browser = await createBrowser();
    const websiteURL = 'https://mbmiums.in/(S(zkvqtk0qyp2cyqpl4smvkq45))/Results/ExamResult.aspx';
    const romanSemester = toRomanNumeral(parseInt(semester));
    
    await cleanFolder(mergedDir);
    
    const prefix = startRoll.slice(0, -4);
    const start = parseInt(startRoll.slice(-4));
    const end = parseInt(endRoll.slice(-4));
    
    const rolls = Array.from(
      { length: end - start + 1 }, 
      (_, i) => `${prefix}${(start + i).toString().padStart(4, '0')}`
    );
    
    job.currentStep = 'processing_rolls';
    
    await processRolls(browser, rolls, websiteURL, semesterType, academicYear, romanSemester, branch, jobId);
    
    console.log('Closing browser');
    await browser.close();
    
    const mergedFile = `Merged_result_${jobId}.pdf`;
    const mergedPath = path.join(mergedDir, mergedFile);
    
    try {
      job.currentStep = 'merging_pdfs';
      console.log(`Starting PDF merge from ${jobDir} to ${mergedPath}`);
      await mergePDFs(jobDir, mergedPath);
      console.log(`PDFs successfully merged to ${mergedPath}`);
      
      await deleteJobFolder(jobId);
      
      job.status = 'done';
      job.currentStep = 'complete';
      job.endTime = Date.now();
      job.downloadURL = `/merged/${mergedFile}`;
      console.log(`Job ${jobId} completed successfully`);
    } catch (err) {
      console.error(`PDF merge error:`, err);
      job.status = 'error';
      job.error = err.message;
      job.currentStep = 'error';
      job.endTime = Date.now();
      
      await deleteJobFolder(jobId);
    }
  } catch (err) {
    console.error(`Fatal error in job ${jobId}:`, err);
    if (jobStore[jobId]) {
      jobStore[jobId].status = 'error';
      jobStore[jobId].error = err.message;
      jobStore[jobId].currentStep = 'error';
      jobStore[jobId].endTime = Date.now();
      
      await deleteJobFolder(jobId);
    }
  } finally {
    isProcessing = false;
    processNextQueuedJob(); // Process the next job
  }
};

app.post('/result', async (req, res) => {
  console.log('Received /result request:', req.body);
  const { startRoll, endRoll, academicYear, semester, semesterType, branch } = req.body;
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const start = parseInt(startRoll.slice(-4));
  const end = parseInt(endRoll.slice(-4));
  const prefix = startRoll.slice(0, -4);
  const total = end - start + 1;

  const status = isProcessing ? 'queued' : 'pending';
  const queuePosition = isProcessing ? jobQueue.length + 1 : 0;

  console.log(`Creating job ${jobId} for rolls ${startRoll} to ${endRoll}, total: ${total}, status: ${status}`);
  
  jobStore[jobId] = { 
    status, 
    queuePosition,
    completed: 0, 
    total, 
    notFound: [], 
    successful: [],
    startTime: Date.now(),
    lastProcessedRoll: null,
    currentStep: status === 'queued' ? 'queued' : 'initializing',
    config: {
      startRoll,
      endRoll,
      academicYear,
      semester,
      semesterType,
      branch
    }
  };
  
  if (status === 'queued') {
    jobQueue.push(jobId);
    console.log(`Job ${jobId} added to queue at position ${queuePosition}`);
    res.json({ jobId, queued: true, queuePosition });
  } else {
    res.json({ jobId });
    processNextQueuedJob();
  }
});

app.post('/cancel/:jobId', async (req, res) => {
  const jobId = req.params.jobId;
  console.log(`Received cancellation request for job: ${jobId}`);
  
  const job = jobStore[jobId];
  if (!job) {
    console.log(`Job ${jobId} not found for cancellation`);
    return res.status(404).json({ error: 'Job not found' });
  }
  
  if (job.status !== 'pending' && job.status !== 'queued') {
    console.log(`Cannot cancel job ${jobId} with status ${job.status}`);
    return res.status(400).json({ error: 'Job cannot be cancelled in its current state' });
  }
  
  try {
    if (job.status === 'queued') {
      const queueIndex = jobQueue.indexOf(jobId);
      if (queueIndex !== -1) {
        jobQueue.splice(queueIndex, 1);
        
        jobQueue.forEach((queuedJobId, index) => {
          if (jobStore[queuedJobId]) {
            jobStore[queuedJobId].queuePosition = index + 1;
          }
        });
      }
    }
    
    job.status = 'canceled';
    job.currentStep = 'canceled';
    job.endTime = Date.now();
    job.queuePosition = null;
    
    console.log(`Job ${jobId} marked as canceled`);
    
    await deleteJobFolder(jobId);
    console.log(`Resources cleaned up for canceled job ${jobId}`);
    
    res.json({ success: true, message: 'Job canceled successfully' });
  } catch (err) {
    console.error(`Error canceling job ${jobId}:`, err);
    res.status(500).json({ error: 'Failed to cancel job', message: err.message });
  }
});

app.get('/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  console.log(`Status check for job: ${jobId}`);
  const job = jobStore[jobId];
  if (!job) {
    console.log(`Job ${jobId} not found`);
    return res.status(404).json({ error: 'Job not found' });
  }
  
  const now = Date.now();
  const elapsedMs = now - job.startTime;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const elapsedMinutes = elapsedSeconds / 60;
  
  let speed = 0;
  if (job.completed > 0 && elapsedSeconds > 0) {
    speed = (job.completed / elapsedSeconds) * 60;
  }
  
  let estimatedTimeRemaining = null;
  if (speed > 0 && job.total > job.completed) {
    const remainingRolls = job.total - job.completed;
    estimatedTimeRemaining = remainingRolls / speed;
  }
  
  const progressPercent = job.total > 0 ? 
    `${Math.round((job.completed / job.total) * 100)}%` : '0%';
  
  const enhancedResponse = {
    ...job,
    progress: `${job.completed}/${job.total} (${progressPercent})`,
    progressPercent,
    elapsedTime: {
      seconds: elapsedSeconds,
      minutes: elapsedMinutes.toFixed(2),
      formatted: formatTime(elapsedSeconds)
    },
    processingSpeed: {
      rollsPerMinute: speed.toFixed(2)
    },
    estimatedTimeRemaining: estimatedTimeRemaining ? 
      {
        minutes: estimatedTimeRemaining.toFixed(2),
        formatted: formatTime(Math.round(estimatedTimeRemaining * 60))
      } : null,
    successfulCount: job.successful.length,
    notFoundCount: job.notFound.length,
    recentSuccessful: job.successful.slice(-10).reverse(),
    recentNotFound: job.notFound.slice(-10).reverse()
  };
  
  console.log(`Returning enhanced status for job ${jobId}: ${job.status}, progress: ${job.completed}/${job.total}`);
  res.json(enhancedResponse);
});

function formatTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  return [
    hours > 0 ? String(hours).padStart(2, '0') : null,
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0')
  ].filter(Boolean).join(':');
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  processNextQueuedJob();
});


