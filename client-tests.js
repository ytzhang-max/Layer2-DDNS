// client-tests.js - Unit tests for the client adapter
const { expect } = require('chai');
const sinon = require('sinon');
const { ethers } = require('ethers');
const DDNSClient = require('../DDNSClient');

describe('DDNS Client Adapter', function () {
  let client;
  let mockL1Provider, mockL2Provider;
  let mockL1Registry, mockL2Resolver;

  beforeEach(function () {
    // Create mock providers
    mockL1Provider = {
      getBlockNumber: sinon.stub().resolves(1000)
    };

    mockL2Provider = {
      getBlockNumber: sinon.stub().resolves(5000)
    };

    // Create mock contracts
    mockL1Registry = {
      getDomain: sinon.stub().resolves([
        '0x1234567890123456789012345678901234567890', // owner
        '0x0000000000000000000000000000000000000000000000000000000000000123', // contentHash
        Math.floor(Date.now() / 1000), // lastUpdated
        Math.floor(Date.now() / 1000) + 31536000 // expiryDate (1 year)
      ])
    };

    mockL2Resolver = {
      getRecord: sinon.stub().resolves(['192.168.1.1', 3600, Math.floor(Date.now() / 1000)]),
      getBatchRecords: sinon.stub().resolves([
        ['192.168.1.1', '2001:db8::1', 'Test record'],
        [3600, 3600, 7200],
        [Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)]
      ])
    };

    // Setup client with mocks
    client = new DDNSClient({
      l1RpcUrl: 'http://fake-l1-url',
      l2RpcUrl: 'http://fake-l2-url',
      l1RegistryAddress: '0x1234567890123456789012345678901234567890',
      l2ResolverAddress: '0x0987654321098765432109876543210987654321',
      preferL2: true,
      useCache: true,
      cacheTTL: 300
    });

    // Replace real objects with mocks
    client.l1Provider = mockL1Provider;
    client.l2Provider = mockL2Provider;
    client.l1Registry = mockL1Registry;
    client.l2Resolver = mockL2Resolver;

    // Mock _getRecordsFromIPFS
    sinon.stub(client, '_getRecordsFromIPFS').resolves({
      domain: 'test.eth',
      records: {
        A: '192.168.1.1',
        AAAA: '2001:db8::1',
        TXT: 'Test record'
      },
      ttl: 3600,
      timestamp: Math.floor(Date.now() / 1000)
    });
  });

  afterEach(function () {
    // Restore stubs
    sinon.restore();
  });

  describe('resolveDomain()', function () {
    it('should resolve from L2 by default', async function () {
      const result = await client.resolveDomain('test.eth', 'A');

      expect(result.value).to.equal('192.168.1.1');
      expect(result.ttl).to.equal(3600);
      expect(result.source).to.equal('l2');
      expect(mockL2Resolver.getRecord.called).to.be.true;
      expect(mockL1Registry.getDomain.called).to.be.false;
      expect(client.stats.l2Queries).to.equal(1);
    });

    it('should force L1 resolution when specified', async function () {
      const result = await client.resolveDomain('test.eth', 'A', { forceL1: true });

      expect(result.value).to.equal('192.168.1.1');
      expect(result.ttl).to.equal(3600);
      expect(result.source).to.equal('l1');
      expect(mockL1Registry.getDomain.called).to.be.true;
      expect(mockL2Resolver.getRecord.called).to.be.false;
      expect(client.stats.l1Queries).to.equal(1);
    });

    it('should use cache for repeated queries', async function () {
      // First query will hit L2
      const result1 = await client.resolveDomain('test.eth', 'A');
      expect(result1.source).to.equal('l2');

      // Second query should hit cache
      const result2 = await client.resolveDomain('test.eth', 'A');
      expect(result2.source).to.equal('cache');
      expect(client.stats.cacheHits).to.equal(1);

      // Should only have one L2 query
      expect(client.stats.l2Queries).to.equal(1);
    });

    it('should skip cache when specified', async function () {
      // First query will hit L2
      const result1 = await client.resolveDomain('test.eth', 'A');
      expect(result1.source).to.equal('l2');

      // Second query with skipCache should hit L2 again
      const result2 = await client.resolveDomain('test.eth', 'A', { skipCache: true });
      expect(result2.source).to.equal('l2');
      expect(client.stats.cacheHits).to.equal(0);

      // Should have two L2 queries
      expect(client.stats.l2Queries).to.equal(2);
    });

    it('should verify with L1 when specified', async function () {
      // Setup for a mismatch
      client._resolveFromL1 = sinon.stub().resolves({
        value: '192.168.1.2', // Different value
        ttl: 3600,
        source: 'l1',
        contentHash: '0x456'
      });

      client._resolveFromL2 = sinon.stub().resolves({
        value: '192.168.1.1',
        ttl: 3600,
        source: 'l2',
        contentHash: '0x123'
      });

      const result = await client.resolveDomain('test.eth', 'A', { verify: true });

      // Should use L1 result due to mismatch
      expect(result.value).to.equal('192.168.1.2');
      expect(result.source).to.equal('l1');
      expect(client._resolveFromL1.called).to.be.true;
      expect(client._resolveFromL2.called).to.be.true;
    });

    it('should fall back to L1 on L2 failure', async function () {
      // Make L2 fail
      mockL2Resolver.getRecord.rejects(new Error('L2 error'));

      const result = await client.resolveDomain('test.eth', 'A');

      expect(result.value).to.equal('192.168.1.1');
      expect(result.source).to.equal('l1');
      expect(mockL2Resolver.getRecord.called).to.be.true;
      expect(mockL1Registry.getDomain.called).to.be.true;
      expect(client.stats.l2Errors).to.equal(1);
    });
  });

  describe('resolveBatch()', function () {
    it('should batch resolve from L2 by default', async function () {
      const result = await client.resolveBatch('test.eth', ['A', 'AAAA', 'TXT']);

      expect(result.values).to.deep.equal(['192.168.1.1', '2001:db8::1', 'Test record']);
      expect(result.ttls).to.deep.equal([3600, 3600, 7200]);
      expect(result.source).to.equal('l2');
      expect(mockL2Resolver.getBatchRecords.called).to.be.true;
      expect(mockL1Registry.getDomain.called).to.be.false;
      expect(client.stats.l2Queries).to.equal(1);
    });

    it('should force L1 batch resolution when specified', async function () {
      const result = await client.resolveBatch('test.eth', ['A', 'AAAA', 'TXT'], { forceL1: true });

      expect(result.values).to.deep.equal(['192.168.1.1', '2001:db8::1', 'Test record']);
      expect(result.source).to.equal('l1');
      expect(mockL1Registry.getDomain.called).to.be.true;
      expect(mockL2Resolver.getBatchRecords.called).to.be.false;
      expect(client.stats.l1Queries).to.equal(1);
    });

    it('should handle L2 batch errors', async function () {
      // Make L2 fail
      mockL2Resolver.getBatchRecords.rejects(new Error('L2 error'));

      const result = await client.resolveBatch('test.eth', ['A', 'AAAA', 'TXT']);

      expect(result.values).to.deep.equal(['192.168.1.1', '2001:db8::1', 'Test record']);
      expect(result.source).to.equal('l1');
      expect(mockL2Resolver.getBatchRecords.called).to.be.true;
      expect(mockL1Registry.getDomain.called).to.be.true;
      expect(client.stats.l2Errors).to.equal(1);
    });
  });

  describe('getStats()', function () {
    it('should calculate performance statistics', async function () {
      // Set up some test data
      client.stats = {
        totalQueries: 10,
        l1Queries: 3,
        l2Queries: 6,
        cacheHits: 1,
        l1LatencySum: 900, // 300ms average
        l2LatencySum: 180, // 30ms average
        l1Errors: 0,
        l2Errors: 0
      };

      const stats = client.getStats();

      expect(stats.l1AvgLatency).to.equal(300);
      expect(stats.l2AvgLatency).to.equal(30);
      expect(stats.cacheHitRate).to.equal(10);
      expect(stats.latencyReduction).to.equal(90);
    });
  });

  describe('clearCache()', function () {
    it('should clear the cache', async function () {
      // First query populates cache
      await client.resolveDomain('test.eth', 'A');

      // Second query hits cache
      const cachedResult = await client.resolveDomain('test.eth', 'A');
      expect(cachedResult.source).to.equal('cache');

      // Clear cache
      client.clearCache();

      // Third query should miss cache
      const uncachedResult = await client.resolveDomain('test.eth', 'A');
      expect(uncachedResult.source).to.equal('l2');

      // Should have 1 cache hit out of 3 queries
      expect(client.stats.cacheHits).to.equal(1);
      expect(client.stats.totalQueries).to.equal(3);
    });
  });
});