// bridge-tests.js - Unit tests for the bridge service
const { expect } = require('chai');
const sinon = require('sinon');
const { ethers } = require('ethers');
const DDNSBridge = require('../DDNSBridge');

describe('DDNS Bridge Service', function () {
  let bridge;
  let mockL1Provider, mockL2Provider;
  let mockL1Registry, mockL2Resolver;
  let mockIPFS;

  beforeEach(function () {
    // Create mock providers
    mockL1Provider = {
      getBlockNumber: sinon.stub().resolves(1000),
      getBlock: sinon.stub().resolves({ timestamp: Math.floor(Date.now() / 1000) })
    };

    mockL2Provider = {
      getBlockNumber: sinon.stub().resolves(5000)
    };

    // Create mock contracts
    mockL1Registry = {
      filters: {
        DomainUpdated: sinon.stub().returns({ topics: ['DomainUpdated'] }),
        DomainRegistered: sinon.stub().returns({ topics: ['DomainRegistered'] })
      },
      queryFilter: sinon.stub().resolves([]),
      getDomain: sinon.stub().resolves([
        '0x1234567890123456789012345678901234567890', // owner
        '0x0000000000000000000000000000000000000000000000000000000000000123', // contentHash
        Math.floor(Date.now() / 1000), // lastUpdated
        Math.floor(Date.now() / 1000) + 31536000 // expiryDate (1 year)
      ])
    };

    mockL2Resolver = {
      setBatchRecords: sinon.stub().resolves({
        wait: sinon.stub().resolves()
      })
    };

    // Create mock IPFS
    mockIPFS = {
      cat: sinon.stub().returns([Buffer.from(JSON.stringify({
        domain: 'test.eth',
        records: {
          A: ['192.168.1.1'],
          AAAA: ['2001:db8::1'],
          TXT: ['Test record']
        },
        ttl: 3600,
        timestamp: Math.floor(Date.now() / 1000)
      }))])
    };

    // Create mock wallet
    const mockWallet = {
      address: '0x1234567890123456789012345678901234567890'
    };

    // Setup bridge with mocks
    bridge = new DDNSBridge({
      l1RpcUrl: 'http://fake-l1-url',
      l2RpcUrl: 'http://fake-l2-url',
      l1RegistryAddress: '0x1234567890123456789012345678901234567890',
      l2ResolverAddress: '0x0987654321098765432109876543210987654321',
      privateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
      pollingInterval: 1000,
      maxRetries: 3
    });

    // Replace real objects with mocks
    bridge.l1Provider = mockL1Provider;
    bridge.l2Provider = mockL2Provider;
    bridge.l1Registry = mockL1Registry;
    bridge.l2Resolver = mockL2Resolver;
    bridge.l1Wallet = mockWallet;
    bridge.l2Wallet = mockWallet;
    bridge.ipfs = mockIPFS;

    // Mock interval methods
    sinon.stub(global, 'setInterval').returns(123);
    sinon.stub(global, 'clearInterval');
  });

  afterEach(function () {
    // Restore stubs
    sinon.restore();
  });

  describe('start()', function () {
    it('should initialize correctly', async function () {
      const result = await bridge.start();

      expect(result).to.be.true;
      expect(bridge.lastProcessedBlock).to.equal(990); // 1000 - 10
      expect(setInterval.calledTwice).to.be.true;
    });

    it('should handle startup errors', async function () {
      mockL1Provider.getBlockNumber.rejects(new Error('Connection error'));

      const result = await bridge.start();

      expect(result).to.be.false;
    });
  });

  describe('processNewEvents()', function () {
    it('should process update events', async function () {
      // Setup mock events
      const mockEvents = [
        {
          args: {
            domainHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
            contentHash: '0x2222222222222222222222222222222222222222222222222222222222222222'
          },
          blockNumber: 950
        }
      ];

      mockL1Registry.queryFilter.withArgs(
        { topics: ['DomainUpdated'] },
        991,
        1000
      ).resolves(mockEvents);

      await bridge.processNewEvents();

      expect(bridge.lastProcessedBlock).to.equal(1000);
      expect(bridge.stats.eventsProcessed).to.equal(1);
      expect(bridge.queue.size()).to.equal(1);

      const queueItem = bridge.queue.dequeue();
      expect(queueItem.type).to.equal('update');
      expect(queueItem.domainHash).to.equal('0x1111111111111111111111111111111111111111111111111111111111111111');
    });

    it('should process registration events with content hash', async function () {
      // Setup mock events
      const mockEvents = [
        {
          args: {
            domainHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
            owner: '0x1234567890123456789012345678901234567890',
          },
          blockNumber: 950
        }
      ];

      mockL1Registry.queryFilter.withArgs(
        { topics: ['DomainRegistered'] },
        991,
        1000
      ).resolves(mockEvents);

      // Mock that this domain has a content hash
      mockL1Registry.getDomain.withArgs('0x1111111111111111111111111111111111111111111111111111111111111111')
        .resolves([
          '0x1234567890123456789012345678901234567890', // owner
          '0x3333333333333333333333333333333333333333333333333333333333333333', // contentHash
          Math.floor(Date.now() / 1000), // lastUpdated
          Math.floor(Date.now() / 1000) + 31536000 // expiryDate
        ]);

      await bridge.processNewEvents();

      expect(bridge.lastProcessedBlock).to.equal(1000);
      expect(bridge.stats.eventsProcessed).to.equal(1);
      expect(bridge.queue.size()).to.equal(1);

      const queueItem = bridge.queue.dequeue();
      expect(queueItem.type).to.equal('register');
      expect(queueItem.contentHash).to.equal('0x3333333333333333333333333333333333333333333333333333333333333333');
    });
  });

  describe('processDomainUpdate()', function () {
    it('should process domain updates and sync to L2', async function () {
      const domainHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
      const contentHash = '0x2222222222222222222222222222222222222222222222222222222222222222';

      await bridge.processDomainUpdate(domainHash, contentHash);

      // Check if records were submitted to L2
      expect(mockL2Resolver.setBatchRecords.called).to.be.true;

      const call = mockL2Resolver.setBatchRecords.getCall(0);
      expect(call.args[0]).to.equal(domainHash);
      expect(call.args[1]).to.deep.equal(['A', 'AAAA', 'TXT']);
      expect(call.args[2]).to.deep.equal(['192.168.1.1', '2001:db8::1', 'Test record']);
      expect(call.args[3]).to.deep.equal([3600, 3600, 3600]);

      expect(bridge.stats.updatesSynced).to.equal(1);
    });

    it('should handle IPFS errors', async function () {
      const domainHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
      const contentHash = '0x2222222222222222222222222222222222222222222222222222222222222222';

      // Make IPFS throw an error
      mockIPFS.cat.throws(new Error('IPFS error'));

      // Should still work using mock data
      await bridge.processDomainUpdate(domainHash, contentHash);

      expect(bridge.stats.ipfsRetrievalErrors).to.equal(1);
      expect(mockL2Resolver.setBatchRecords.called).to.be.true;
    });

    it('should handle L2 submission errors', async function () {
      const domainHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
      const contentHash = '0x2222222222222222222222222222222222222222222222222222222222222222';

      // Make L2 submission fail
      mockL2Resolver.setBatchRecords.rejects(new Error('L2 error'));

      try {
        await bridge.processDomainUpdate(domainHash, contentHash);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('L2 error');
        expect(bridge.stats.l2SubmissionErrors).to.equal(1);
      }
    });
  });

  describe('stop()', function () {
    it('should stop polling', async function () {
      await bridge.start();
      const result = bridge.stop();

      expect(result).to.be.true;
      expect(clearInterval.calledWith(123)).to.be.true;
    });
  });
});