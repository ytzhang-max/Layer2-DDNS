// DDNSClient.js - DNS resolution client adapter
const ethers = require('ethers');
const DDNSRegistryABI = require('./abis/DDNSRegistry.json');
const DDNSResolverABI = require('./abis/DDNSResolver.json');

/**
 * DDNS Client Adapter
 * Provides high-performance domain resolution, prioritizing L2 with fallback to L1
 */
class DDNSClient {
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
    this.useCache = config.useCache !== undefined ? config.useCache : true;
    this.cacheTTL = config.cacheTTL || 300; // Default cache for 5 minutes
    this.preferL2 = config.preferL2 !== undefined ? config.preferL2 : true;
    this.verifyWithL1 = config.verifyWithL1 !== undefined ? config.verifyWithL1 : false;

    // Initialize contract interfaces
    this.l1Registry = new ethers.Contract(this.l1RegistryAddress, DDNSRegistryABI, this.l1Provider);
    this.l2Resolver = new ethers.Contract(this.l2ResolverAddress, DDNSResolverABI, this.l2Provider);

    // Initialize cache
    this.cache = {};

    // Performance statistics
    this.stats = {
      totalQueries: 0,
      l1Queries: 0,
      l2Queries: 0,
      cacheHits: 0,
      l1LatencySum: 0,
      l2LatencySum: 0,
      l1Errors: 0,
      l2Errors: 0
    };
  }

  /**
   * Resolve domain
   * @param {string} domainName Domain name
   * @param {string} recordType Record type
   * @param {Object} options Options
   * @returns {Promise<Object>} Resolution result
   */
  async resolveDomain(domainName, recordType, options = {}) {
    const startTime = Date.now();
    this.stats.totalQueries++;

    try {
      // Parse options
      const opts = {
        forceL1: options.forceL1 || false,
        forceL2: options.forceL2 || false,
        skipCache: options.skipCache || false,
        verify: options.verify || this.verifyWithL1
      };

      // Calculate domain hash
      const domainHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(domainName));

      // Cache key
      const cacheKey = `${domainHash}-${recordType}`;

      // Check cache
      if (this.useCache && !opts.skipCache && this.cache[cacheKey]) {
        const cachedResult = this.cache[cacheKey];

        // Check if cache is still valid
        if (cachedResult.timestamp + (cachedResult.ttl * 1000) > Date.now()) {
          this.stats.cacheHits++;
          return {
            ...cachedResult,
            source: 'cache',
            latency: Date.now() - startTime
          };
        }
      }

      // Resolution logic
      let result;

      // Force use of L1
      if (opts.forceL1) {
        result = await this._resolveFromL1(domainHash, recordType);
      }
      // Force use of L2
      else if (opts.forceL2) {
        result = await this._resolveFromL2(domainHash, recordType);
      }
      // Prefer L2
      else if (this.preferL2) {
        try {
          result = await this._resolveFromL2(domainHash, recordType);

          // If verification is needed, compare with L1
          if (opts.verify && result.value) {
            const l1Result = await this._resolveFromL1(domainHash, recordType);

            // If content hashes don't match, use L1 result
            if (l1Result.contentHash !== result.contentHash) {
              console.warn(`L1 and L2 records inconsistent: ${domainName} (${recordType})`);
              result = l1Result;
            }
          }
        } catch (error) {
          console.warn(`L2 resolution failed, falling back to L1: ${error.message}`);
          result = await this._resolveFromL1(domainHash, recordType);
        }
      }
      // Prefer L1
      else {
        result = await this._resolveFromL1(domainHash, recordType);
      }

      // Cache result
      if (this.useCache && result.value) {
        this.cache[cacheKey] = {
          ...result,
          timestamp: Date.now()
        };
      }

      return {
        ...result,
        latency: Date.now() - startTime
      };
    } catch (error) {
      console.error(`Failed to resolve domain ${domainName} (${recordType}):`, error);
      return {
        value: null,
        ttl: 0,
        source: 'error',
        error: error.message,
        latency: Date.now() - startTime
      };
    }
  }

  /**
   * Batch resolve domain records
   * @param {string} domainName Domain name
   * @param {string[]} recordTypes Array of record types
   * @param {Object} options Options
   * @returns {Promise<Object>} Resolution result
   */
  async resolveBatch(domainName, recordTypes, options = {}) {
    const startTime = Date.now();
    this.stats.totalQueries++;

    try {
      // Parse options
      const opts = {
        forceL1: options.forceL1 || false,
        forceL2: options.forceL2 || false,
        skipCache: options.skipCache || false,
        verify: options.verify || this.verifyWithL1
      };

      // Calculate domain hash
      const domainHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(domainName));

      // Resolution logic
      let results;

      // Force use of L1
      if (opts.forceL1) {
        results = await this._resolveBatchFromL1(domainHash, recordTypes);
      }
      // Force use of L2
      else if (opts.forceL2) {
        results = await this._resolveBatchFromL2(domainHash, recordTypes);
      }
      // Prefer L2
      else if (this.preferL2) {
        try {
          results = await this._resolveBatchFromL2(domainHash, recordTypes);

          // If verification is needed, compare with L1
          if (opts.verify) {
            const l1Results = await this._resolveBatchFromL1(domainHash, recordTypes);

            // Compare content hashes
            if (l1Results.contentHash !== results.contentHash) {
              console.warn(`L1 and L2 records inconsistent: ${domainName}`);
              results = l1Results;
            }
          }
        } catch (error) {
          console.warn(`L2 batch resolution failed, falling back to L1: ${error.message}`);
          results = await this._resolveBatchFromL1(domainHash, recordTypes);
        }
      }
      // Prefer L1
      else {
        results = await this._resolveBatchFromL1(domainHash, recordTypes);
      }

      // Cache results
      if (this.useCache) {
        for (let i = 0; i < recordTypes.length; i++) {
          const cacheKey = `${domainHash}-${recordTypes[i]}`;

          if (results.values[i]) {
            this.cache[cacheKey] = {
              value: results.values[i],
              ttl: results.ttls[i],
              contentHash: results.contentHash,
              source: results.source,
              timestamp: Date.now()
            };
          }
        }
      }

      return {
        ...results,
        latency: Date.now() - startTime
      };
    } catch (error) {
      console.error(`Failed to batch resolve domain ${domainName}:`, error);
      return {
        values: Array(recordTypes.length).fill(null),
        ttls: Array(recordTypes.length).fill(0),
        source: 'error',
        error: error.message,
        latency: Date.now() - startTime
      };
    }
  }

  /**
   * Resolve domain from L1
   * @param {string} domainHash Domain hash
   * @param {string} recordType Record type
   * @returns {Promise<Object>} Resolution result
   * @private
   */
  async _resolveFromL1(domainHash, recordType) {
    const startTime = Date.now();
    this.stats.l1Queries++;

    try {
      // Get domain record from L1
      const [owner, contentHash, lastUpdated, expiryDate] = await this.l1Registry.getDomain(domainHash);

      // Check if domain exists
      if (owner === ethers.constants.AddressZero) {
        return { value: null, ttl: 0, source: 'l1', contentHash: null };
      }

      // Check if domain has expired
      if (expiryDate < Math.floor(Date.now() / 1000)) {
        return { value: null, ttl: 0, source: 'l1', contentHash, error: 'Domain expired' };
      }

      // Get complete records from IPFS
      const records = await this._getRecordsFromIPFS(contentHash);

      // Find requested record type
      let recordValue = null;
      let recordTTL = 0;

      if (records && records.records && records.records[recordType]) {
        const recordData = records.records[recordType];

        if (Array.isArray(recordData)) {
          // For multi-value records, return the first one
          recordValue = recordData[0];
        } else {
          recordValue = recordData;
        }

        recordTTL = records.ttl || 3600; // Default 1 hour
      }

      const latency = Date.now() - startTime;
      this.stats.l1LatencySum += latency;

      return {
        value: recordValue,
        ttl: recordTTL,
        source: 'l1',
        contentHash,
        owner,
        lastUpdated,
        expiryDate
      };
    } catch (error) {
      console.error(`L1 resolution failed: ${error.message}`);
      this.stats.l1Errors++;
      throw error;
    }
  }

  /**
   * Resolve domain from L2
   * @param {string} domainHash Domain hash
   * @param {string} recordType Record type
   * @returns {Promise<Object>} Resolution result
   * @private
   */
  async _resolveFromL2(domainHash, recordType) {
    const startTime = Date.now();
    this.stats.l2Queries++;

    try {
      // Get record from L2
      const [value, ttl, timestamp] = await this.l2Resolver.getRecord(domainHash, recordType);

      const latency = Date.now() - startTime;
      this.stats.l2LatencySum += latency;

      // If no record, return empty result
      if (!value) {
        return { value: null, ttl: 0, source: 'l2' };
      }

      return {
        value: value,
        ttl: ttl,
        source: 'l2',
        timestamp
      };
    } catch (error) {
      console.error(`L2 resolution failed: ${error.message}`);
      this.stats.l2Errors++;
      throw error;
    }
  }

  /**
   * Batch resolve domain from L1
   * @param {string} domainHash Domain hash
   * @param {string[]} recordTypes Array of record types
   * @returns {Promise<Object>} Resolution result
   * @private
   */
  async _resolveBatchFromL1(domainHash, recordTypes) {
    const startTime = Date.now();
    this.stats.l1Queries++;

    try {
      // Get domain record from L1
      const [owner, contentHash, lastUpdated, expiryDate] = await this.l1Registry.getDomain(domainHash);

      // Check if domain exists
      if (owner === ethers.constants.AddressZero) {
        return {
          values: Array(recordTypes.length).fill(null),
          ttls: Array(recordTypes.length).fill(0),
          source: 'l1',
          contentHash: null
        };
      }

      // Check if domain has expired
      if (expiryDate < Math.floor(Date.now() / 1000)) {
        return {
          values: Array(recordTypes.length).fill(null),
          ttls: Array(recordTypes.length).fill(0),
          source: 'l1',
          contentHash,
          error: 'Domain expired'
        };
      }

      // Get complete records from IPFS
      const records = await this._getRecordsFromIPFS(contentHash);

      // Prepare return arrays
      const values = new Array(recordTypes.length);
      const ttls = new Array(recordTypes.length);

      // Fill in record values
      for (let i = 0; i < recordTypes.length; i++) {
        const type = recordTypes[i];

        if (records && records.records && records.records[type]) {
          const recordData = records.records[type];

          if (Array.isArray(recordData)) {
            // For multi-value records, return the first one
            values[i] = recordData[0];
          } else {
            values[i] = recordData;
          }

          ttls[i] = records.ttl || 3600; // Default 1 hour
        } else {
          values[i] = null;
          ttls[i] = 0;
        }
      }

      const latency = Date.now() - startTime;
      this.stats.l1LatencySum += latency;

      return {
        values,
        ttls,
        source: 'l1',
        contentHash,
        owner,
        lastUpdated,
        expiryDate
      };
    } catch (error) {
      console.error(`L1 batch resolution failed: ${error.message}`);
      this.stats.l1Errors++;
      throw error;
    }
  }

  /**
   * Batch resolve domain from L2
   * @param {string} domainHash Domain hash
   * @param {string[]} recordTypes Array of record types
   * @returns {Promise<Object>} Resolution result
   * @private
   */
  async _resolveBatchFromL2(domainHash, recordTypes) {
    const startTime = Date.now();
    this.stats.l2Queries++;

    try {
      // Batch get records from L2
      const [values, ttls, timestamps] = await this.l2Resolver.getBatchRecords(domainHash, recordTypes);

      const latency = Date.now() - startTime;
      this.stats.l2LatencySum += latency;

      return {
        values,
        ttls,
        source: 'l2',
        timestamps
      };
    } catch (error) {
      console.error(`L2 batch resolution failed: ${error.message}`);
      this.stats.l2Errors++;
      throw error;
    }
  }

  /**
   * Get DNS records from IPFS
   * @param {string} contentHash Content hash
   * @returns {Promise<Object>} DNS records object
   * @private
   */
  async _getRecordsFromIPFS(contentHash) {
    try {
      // In a production system, this would implement actual IPFS querying
      // For simplicity, using mock data here

      // Simulate delay (IPFS queries typically take some time)
      await new Promise(resolve => setTimeout(resolve, 100));

      // Use mock data
      return this._getMockRecordsFromHash(contentHash);
    } catch (error) {
      console.error('Error retrieving records from IPFS:', error);
      throw error;
    }
  }

  /**
   * Generate mock records from content hash (for testing only)
   * @param {string} contentHash Content hash
   * @returns {Object} Mock DNS records object
   * @private
   */
  _getMockRecordsFromHash(contentHash) {
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
   * Clear cache
   */
  clearCache() {
    this.cache = {};
    console.log('Client cache cleared');
  }

  /**
   * Get performance statistics
   * @returns {Object} Performance statistics object
   */
  getStats() {
    const l1AvgLatency = this.stats.l1Queries > 0 ? this.stats.l1LatencySum / this.stats.l1Queries : 0;
    const l2AvgLatency = this.stats.l2Queries > 0 ? this.stats.l2LatencySum / this.stats.l2Queries : 0;
    const cacheHitRate = this.stats.totalQueries > 0 ? (this.stats.cacheHits / this.stats.totalQueries) * 100 : 0;

    return {
      ...this.stats,
      l1AvgLatency,
      l2AvgLatency,
      cacheHitRate,
      latencyReduction: l1AvgLatency > 0 && l2AvgLatency > 0 ?
        ((l1AvgLatency - l2AvgLatency) / l1AvgLatency) * 100 : 0
    };
  }
}

module.exports = DDNSClient;