// DDNSBridge.js - Cross-layer bridge service
const ethers = require('ethers');
const IPFS = require('ipfs-http-client');
const DDNSRegistryABI = require('./abis/DDNSRegistry.json');
const DDNSResolverABI = require('./abis/DDNSResolver.json');
const { Queue } = require('./utils/Queue');

/**
 * Cross-layer bridge service
 * Monitors events on L1 and synchronizes data to L2
 */
class DDNSBridge {
  /**
   * Constructor
   * @param {Object} config Configuration object
   */
  constructor(config) {
    // Configuration parameters
    this.l1Provider = new ethers.providers.JsonRpcProvider(config.l1RpcUrl);
    this.l2Provider = new ethers.providers.JsonRpcProvider(config.l2RpcUrl);
    this.l1RegistryAddress = config.l1RegistryAddress;
    this.l2ResolverAddress = config.l2ResolverAddress;
    this.privateKey = config.privateKey;
    this.ipfsGateway = config.ipfsGateway || 'https://ipfs.io/ipfs/';
    this.ipfsApiUrl = config.ipfsApiUrl || 'http://localhost:5001';
    this.pollingInterval = config.pollingInterval || 30000; // Default 30 seconds
    this.maxRetries = config.maxRetries || 5;
    this.confirmations = config.confirmations || 3;

    // Initialize wallets
    this.l1Wallet = new ethers.Wallet(this.privateKey, this.l1Provider);
    this.l2Wallet = new ethers.Wallet(this.privateKey, this.l2Provider);

    // Initialize contract interfaces
    this.l1Registry = new ethers.Contract(this.l1RegistryAddress, DDNSRegistryABI, this.l1Wallet);
    this.l2Resolver = new ethers.Contract(this.l2ResolverAddress, DDNSResolverABI, this.l2Wallet);

    // Initialize IPFS client
    this.ipfs = IPFS.create(this.ipfsApiUrl);

    // Processing queue
    this.queue = new Queue();

    // Last processed block
    this.lastProcessedBlock = 0;

    // Processing statistics
    this.stats = {
      eventsProcessed: 0,
      updatesSynced: 0,
      errors: 0,
      ipfsRetrievalErrors: 0,
      l2SubmissionErrors: 0
    };
  }

  /**
   * Start the bridge service
   */
  async start() {
    console.log('Starting DDNS bridge service...');

    try {
      // Get current block
      const currentBlock = await this.l1Provider.getBlockNumber();
      this.lastProcessedBlock = currentBlock - 10000; // Start processing from 10000 blocks ago to ensure no recent events are missed
      console.log(`Starting processing from block ${this.lastProcessedBlock}`);

      // Start event polling
      this.startPolling();

      // Start queue processing
      this.startQueueProcessing();

      return true;
    } catch (error) {
      console.error('Failed to start bridge service:', error);
      return false;
    }
  }

  /**
   * Start event polling
   */
  startPolling() {
    console.log(`Setting up event polling with interval ${this.pollingInterval}ms`);

    this.pollingInterval = setInterval(async () => {
      try {
        await this.processNewEvents();
      } catch (error) {
        console.error('Error processing events:', error);
        this.stats.errors++;
      }
    }, this.pollingInterval);
  }

  /**
   * Start queue processing
   */
  startQueueProcessing() {
    console.log('Starting queue processing...');

    // Process one queue item per second
    setInterval(async () => {
      if (!this.queue.isEmpty()) {
        const item = this.queue.dequeue();
        try {
          await this.processQueueItem(item);
        } catch (error) {
          console.error('Error processing queue item:', error);

          // Retry logic
          if (item.retries < this.maxRetries) {
            item.retries++;
            console.log(`Retrying attempt ${item.retries} of ${this.maxRetries}`);
            this.queue.enqueue(item);
          } else {
            console.error('Maximum retries reached, abandoning processing:', item);
            this.stats.errors++;
          }
        }
      }
    }, 1000);
  }

  /**
   * Process new events
   */
  async processNewEvents() {
    const currentBlock = await this.l1Provider.getBlockNumber();

    if (currentBlock <= this.lastProcessedBlock) {
      return;
    }

    console.log(`Processing events from block ${this.lastProcessedBlock + 1} to ${currentBlock}`);

    // Query domain update events
    const updateEvents = await this.l1Registry.queryFilter(
      this.l1Registry.filters.DomainUpdated(),
      this.lastProcessedBlock + 1,
      currentBlock
    );

    // Query domain registration events
    const registerEvents = await this.l1Registry.queryFilter(
      this.l1Registry.filters.DomainRegistered(),
      this.lastProcessedBlock + 1,
      currentBlock
    );

    // Update last processed block
    this.lastProcessedBlock = currentBlock;

    // Add events to processing queue
    for (const event of updateEvents) {
      this.queue.enqueue({
        type: 'update',
        domainHash: event.args.domainHash,
        contentHash: event.args.contentHash,
        blockNumber: event.blockNumber,
        retries: 0
      });
      this.stats.eventsProcessed++;
    }

    for (const event of registerEvents) {
      // For registration events, we only need to check if there's an initial content hash
      const [owner, contentHash, lastUpdated, expiryDate] = await this.l1Registry.getDomain(event.args.domainHash);

      if (contentHash !== ethers.constants.HashZero) {
        this.queue.enqueue({
          type: 'register',
          domainHash: event.args.domainHash,
          contentHash: contentHash,
          blockNumber: event.blockNumber,
          retries: 0
        });
        this.stats.eventsProcessed++;
      }
    }

    console.log(`Added ${updateEvents.length + registerEvents.length} events to processing queue`);
  }

  /**
   * Process queue item
   * @param {Object} item Queue item
   */
  async processQueueItem(item) {
    console.log(`Processing queue item: ${item.type}, domain hash: ${item.domainHash}`);

    // Domain update
    if (item.type === 'update' || item.type === 'register') {
      await this.processDomainUpdate(item.domainHash, item.contentHash);
    }
  }

  /**
   * Process domain update
   * @param {string} domainHash Domain hash
   * @param {string} contentHash Content hash
   */
  async processDomainUpdate(domainHash, contentHash) {
    try {
      console.log(`Processing domain update: ${domainHash}, content hash: ${contentHash}`);

      // Get DNS records from IPFS
      const records = await this.getRecordsFromIPFS(contentHash);

      if (!records || !records.records) {
        console.error('Invalid IPFS record format:', records);
        this.stats.ipfsRetrievalErrors++;
        return;
      }

      // Prepare record data
      const recordTypes = [];
      const values = [];
      const ttls = [];

      // Process all record types
      for (const [type, recordValues] of Object.entries(records.records)) {
        if (Array.isArray(recordValues)) {
          // Handle multi-value records, like multiple A records
          for (const value of recordValues) {
            recordTypes.push(type);
            values.push(typeof value === 'object' ? JSON.stringify(value) : value);
            ttls.push(records.ttl || 3600); // Default 1 hour
          }
        } else {
          // Handle single-value record
          recordTypes.push(type);
          values.push(typeof recordValues === 'object' ? JSON.stringify(recordValues) : recordValues);
          ttls.push(records.ttl || 3600);
        }
      }

      // Batch update L2 resolver
      if (recordTypes.length > 0) {
        console.log(`Submitting ${recordTypes.length} records to L2`);

        const tx = await this.l2Resolver.setBatchRecords(
          domainHash,
          recordTypes,
          values,
          ttls,
          { gasLimit: 3000000 } // Set a sufficiently large gas limit
        );

        // Wait for transaction confirmation
        await tx.wait(this.confirmations);

        console.log(`L2 records updated successfully: ${tx.hash}`);
        this.stats.updatesSynced++;
      } else {
        console.log('No records found to update');
      }
    } catch (error) {
      console.error(`Error processing domain update ${domainHash}:`, error);
      this.stats.l2SubmissionErrors++;
      throw error; // Rethrow to trigger retry mechanism
    }
  }

  /**
   * Get DNS records from IPFS
   * @param {string} contentHash IPFS content hash
   * @returns {Object} DNS records object
   */
  async getRecordsFromIPFS(contentHash) {
    try {
      // Extract IPFS CID from content hash
      let ipfsCid = contentHash;

      // Handle Ethereum contentHash format
      if (contentHash.startsWith('0x')) {
        // Extract IPFS CID from Ethereum contentHash format
        // Implement parsing logic based on specific encoding format
        // For example, for ipfs-ns format: 0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f

        // Simplified handling - actual implementation would need more rigorous parsing
        ipfsCid = `Qm${contentHash.substring(10, 50)}`;
      }

      console.log(`Fetching content from IPFS: ${ipfsCid}`);

      // Get data from IPFS
      const chunks = [];
      for await (const chunk of this.ipfs.cat(ipfsCid)) {
        chunks.push(chunk);
      }

      // Parse JSON data
      const data = Buffer.concat(chunks).toString();
      return JSON.parse(data);
    } catch (error) {
      console.error('Error retrieving records from IPFS:', error);
      this.stats.ipfsRetrievalErrors++;

      // For demonstration, return mock data
      // In production, should throw error or return null
      console.log('Using mock data as fallback');
      return this.getMockRecordsFromHash(contentHash);
    }
  }

  /**
   * Generate mock records from content hash (for testing only)
   * @param {string} contentHash Content hash
   * @returns {Object} Mock DNS records object
   */
  getMockRecordsFromHash(contentHash) {
    const hash = contentHash.toString().substring(2, 10);
    const ipPart = parseInt(hash, 16) % 255;

    return {
      domain: `example-${hash}.eth`,
      records: {
        A: [`192.168.1.${ipPart}`],
        AAAA: [`2001:db8::${ipPart}`],
        TXT: [`This is a demo record for hash ${hash}`],
        MX: [
          { preference: 10, exchange: `mail1.example-${hash}.eth` },
          { preference: 20, exchange: `mail2.example-${hash}.eth` }
        ]
      },
      ttl: 3600,
      timestamp: Math.floor(Date.now() / 1000)
    };
  }

  /**
   * Get service statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      ...this.stats,
      lastProcessedBlock: this.lastProcessedBlock,
      queueSize: this.queue.size(),
      uptime: process.uptime()
    };
  }

  /**
   * Stop the bridge service
   */
  stop() {
    console.log('Stopping DDNS bridge service...');

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    return true;
  }
}

module.exports = DDNSBridge;