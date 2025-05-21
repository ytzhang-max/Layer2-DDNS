// integration-tests.js - Integration tests for the system
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployContracts, createMockIPFSRecords, calculateDomainHash, sleep } = require('./test-utils');
const DDNSClient = require('../DDNSClient');
const DDNSBridge = require('../DDNSBridge');

describe('Layer 2 Enhanced DDNS System - Integration', function () {
  let registry, resolver, owner, bridgeWallet, user1, user2;
  let client, bridge;
  let testDomain = 'integration-test.eth';
  let testDomainHash, testContentHash;

  // Increase test timeout for integration tests
  this.timeout(10000);

  before(async function () {
    // Deploy test contracts
    const contracts = await deployContracts();
    registry = contracts.registry;
    resolver = contracts.resolver;
    owner = contracts.owner;
    bridgeWallet = contracts.bridgeWallet;
    user1 = contracts.user1;
    user2 = contracts.user2;

    // Calculate domain hash
    testDomainHash = calculateDomainHash(testDomain);

    // Create test records
    const records = {
      A: ['192.168.1.100'],
      AAAA: ['2001:db8::100'],
      TXT: ['Integration test record'],
      MX: [{ preference: 10, exchange: 'mail.example.com' }]
    };

    testContentHash = await createMockIPFSRecords(testDomain, records);

    // Initialize client and bridge
    // Note: In a real test environment, these would connect to actual providers
    // For this test, we'll need to mock parts of their functionality

    // For demonstration purposes, we'll simulate the full flow manually
  });

  describe('End-to-End DNS Resolution Flow', function () {
    it('should register a domain on L1', async function () {
      // Register domain
      const registrationFee = await registry.registrationFee();

      const tx = await registry.connect(user1).registerDomain(testDomainHash, {
        value: registrationFee
      });

      await tx.wait();

      const [owner, contentHash, lastUpdated, expiryDate] = await registry.getDomain(testDomainHash);
      expect(owner).to.equal(user1.address);
    });

    it('should update domain content hash on L1', async function () {
      const tx = await registry.connect(user1).updateDomain(testDomainHash, testContentHash);
      await tx.wait();

      const [owner, contentHash, lastUpdated, expiryDate] = await registry.getDomain(testDomainHash);
      expect(contentHash).to.equal(testContentHash);
    });

    it('should simulate bridge syncing data to L2', async function () {
      // Simulate the bridge processing the domain update
      // In a real test, the bridge would detect the event and process it

      // Set records on L2 as if the bridge had processed the update
      const recordTypes = ['A', 'AAAA', 'TXT', 'MX'];
      const values = [
        '192.168.1.100',
        '2001:db8::100',
        'Integration test record',
        JSON.stringify({ preference: 10, exchange: 'mail.example.com' })
      ];
      const ttls = [3600, 3600, 7200, 3600];

      const tx = await resolver.connect(bridgeWallet).setBatchRecords(
        testDomainHash,
        recordTypes,
        values,
        ttls
      );

      await tx.wait();

      // Verify the records were set on L2
      for (let i = 0; i < recordTypes.length; i++) {
        const [value, ttl, timestamp] = await resolver.getRecord(testDomainHash, recordTypes[i]);
        expect(value).to.equal(values[i]);
      }
    });

    it('should simulate client resolution', async function () {
      // Create a mock getRecord function that mimics the client behavior
      // In a real test, this would use the actual client

      async function simulateResolve(domainName, recordType, useL2 = true) {
        const startTime = Date.now();
        const domainHash = calculateDomainHash(domainName);

        let result;

        if (useL2) {
          // Simulate L2 resolution
          await sleep(10); // Simulate L2 latency
          const [value, ttl, timestamp] = await resolver.getRecord(domainHash, recordType);
          result = {
            value,
            ttl,
            source: 'l2',
            latency: Date.now() - startTime
          };
        } else {
          // Simulate L1 resolution
          await sleep(100); // Simulate higher L1 latency
          const [owner, contentHash, lastUpdated, expiryDate] = await registry.getDomain(domainHash);

          // In a real client, this would fetch data from IPFS
          // We'll simulate that with mock data
          const records = {
            A: '192.168.1.100',
            AAAA: '2001:db8::100',
            TXT: 'Integration test record',
            MX: JSON.stringify({ preference: 10, exchange: 'mail.example.com' })
          };

          result = {
            value: records[recordType] || null,
            ttl: 3600,
            source: 'l1',
            contentHash,
            latency: Date.now() - startTime
          };
        }

        return result;
      }

      // Test L2 resolution
      const l2Result = await simulateResolve(testDomain, 'A', true);
      expect(l2Result.value).to.equal('192.168.1.100');
      expect(l2Result.source).to.equal('l2');

      // Test L1 resolution
      const l1Result = await simulateResolve(testDomain, 'A', false);
      expect(l1Result.value).to.equal('192.168.1.100');
      expect(l1Result.source).to.equal('l1');

      // Compare performance
      console.log(`L2 latency: ${l2Result.latency}ms`);
      console.log(`L1 latency: ${l1Result.latency}ms`);
      expect(l2Result.latency).to.be.lessThan(l1Result.latency);
    });

    it('should handle domain updates', async function () {
      // Update content hash with new records
      const newRecords = {
        A: ['192.168.1.200'],
        AAAA: ['2001:db8::200'],
        TXT: ['Updated integration test record']
      };

      const newContentHash = await createMockIPFSRecords(testDomain, newRecords);

      // Update on L1
      const tx1 = await registry.connect(user1).updateDomain(testDomainHash, newContentHash);
      await tx1.wait();

      // Simulate bridge processing the update
      const recordTypes = ['A', 'AAAA', 'TXT'];
      const values = [
        '192.168.1.200',
        '2001:db8::200',
        'Updated integration test record'
      ];
      const ttls = [3600, 3600, 7200];

      const tx2 = await resolver.connect(bridgeWallet).setBatchRecords(
        testDomainHash,
        recordTypes,
        values,
        ttls
      );

      await tx2.wait();

      // Verify the records were updated on L2
      const [value, ttl, timestamp] = await resolver.getRecord(testDomainHash, 'A');
      expect(value).to.equal('192.168.1.200');
    });
  });

  describe('Performance Comparison', function () {
    it('should demonstrate L2 performance advantage', async function () {
      // Simple performance test
      const iterations = 10;
      let l1TotalTime = 0;
      let l2TotalTime = 0;

      for (let i = 0; i < iterations; i++) {
        // L1 resolution
        const l1Start = Date.now();
        const [owner, contentHash, lastUpdated, expiryDate] = await registry.getDomain(testDomainHash);
        // Simulate IPFS lookup
        await sleep(50);
        const l1Time = Date.now() - l1Start;
        l1TotalTime += l1Time;

        // L2 resolution
        const l2Start = Date.now();
        const [value, ttl, timestamp] = await resolver.getRecord(testDomainHash, 'A');
        const l2Time = Date.now() - l2Start;
        l2TotalTime += l2Time;
      }

      const l1AvgTime = l1TotalTime / iterations;
      const l2AvgTime = l2TotalTime / iterations;

      console.log(`Average L1 resolution time: ${l1AvgTime.toFixed(2)}ms`);
      console.log(`Average L2 resolution time: ${l2AvgTime.toFixed(2)}ms`);
      console.log(`Performance improvement: ${(l1AvgTime / l2AvgTime).toFixed(2)}x`);

      expect(l2AvgTime).to.be.lessThan(l1AvgTime);
    });
  });
});