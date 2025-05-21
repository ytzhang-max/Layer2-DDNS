// contract-tests.js - Smart contract tests
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployContracts, createMockIPFSRecords, calculateDomainHash } = require('./test-utils');

describe('Layer 2 Enhanced DDNS System - Contracts', function () {
  let registry, resolver, owner, bridgeWallet, user1, user2;
  let testDomainHash, testContentHash;

  before(async function () {
    // Deploy test contracts
    const contracts = await deployContracts();
    registry = contracts.registry;
    resolver = contracts.resolver;
    owner = contracts.owner;
    bridgeWallet = contracts.bridgeWallet;
    user1 = contracts.user1;
    user2 = contracts.user2;

    // Prepare test data
    const testDomain = 'test.eth';
    testDomainHash = calculateDomainHash(testDomain);

    // Create mock records
    const records = {
      A: ['192.168.1.1'],
      AAAA: ['2001:db8::1'],
      TXT: ['Test record']
    };

    testContentHash = await createMockIPFSRecords(testDomain, records);
  });

  describe('Layer 1 Registry', function () {
    it('should allow domain registration', async function () {
      // Register a domain with 0.01 ETH
      const registrationFee = await registry.registrationFee();

      const tx = await registry.connect(user1).registerDomain(testDomainHash, {
        value: registrationFee
      });

      // Check events and state
      await expect(tx)
        .to.emit(registry, 'DomainRegistered')
        .withArgs(testDomainHash, user1.address, ethers.BigNumber.from(0).add(await getExpiryDate()));

      const [owner, contentHash, lastUpdated, expiryDate] = await registry.getDomain(testDomainHash);
      expect(owner).to.equal(user1.address);
      expect(contentHash).to.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('should prevent registering already registered domains', async function () {
      const registrationFee = await registry.registrationFee();

      await expect(
        registry.connect(user2).registerDomain(testDomainHash, {
          value: registrationFee
        })
      ).to.be.revertedWith('DDNSRegistry: domain already registered');
    });

    it('should allow updating domain content hash', async function () {
      const tx = await registry.connect(user1).updateDomain(testDomainHash, testContentHash);

      await expect(tx)
        .to.emit(registry, 'DomainUpdated')
        .withArgs(testDomainHash, testContentHash);

      const [owner, contentHash, lastUpdated, expiryDate] = await registry.getDomain(testDomainHash);
      expect(contentHash).to.equal(testContentHash);
    });

    it('should prevent updating domain by non-owners', async function () {
      await expect(
        registry.connect(user2).updateDomain(testDomainHash, testContentHash)
      ).to.be.revertedWith('DDNSRegistry: caller is not the domain owner');
    });

    it('should allow transferring domain ownership', async function () {
      const tx = await registry.connect(user1).transferDomain(testDomainHash, user2.address);

      await expect(tx)
        .to.emit(registry, 'DomainTransferred')
        .withArgs(testDomainHash, user1.address, user2.address);

      const [owner, contentHash, lastUpdated, expiryDate] = await registry.getDomain(testDomainHash);
      expect(owner).to.equal(user2.address);
    });

    it('should track domains owned by users', async function () {
      const domainsOwned = await registry.getUserDomains(user2.address);
      expect(domainsOwned).to.include(testDomainHash);

      const noDomainsOwned = await registry.getUserDomains(user1.address);
      expect(noDomainsOwned).to.not.include(testDomainHash);
    });
  });

  describe('Layer 2 Resolver', function () {
    it('should prevent unauthorized record updates', async function () {
      await expect(
        resolver.connect(user1).setRecord(testDomainHash, 'A', '192.168.1.1', 3600)
      ).to.be.revertedWith('DDNSResolver: caller is not the bridge');
    });

    it('should allow bridge to set records', async function () {
      const tx = await resolver.connect(bridgeWallet).setRecord(
        testDomainHash,
        'A',
        '192.168.1.1',
        3600
      );

      await expect(tx)
        .to.emit(resolver, 'RecordSet')
        .withArgs(testDomainHash, 'A', '192.168.1.1', 3600);

      const [value, ttl, timestamp] = await resolver.getRecord(testDomainHash, 'A');
      expect(value).to.equal('192.168.1.1');
      expect(ttl).to.equal(3600);
    });

    it('should allow bridge to batch set records', async function () {
      const recordTypes = ['AAAA', 'TXT', 'MX'];
      const values = ['2001:db8::1', 'Test record', 'mail.example.com'];
      const ttls = [3600, 7200, 3600];

      const tx = await resolver.connect(bridgeWallet).setBatchRecords(
        testDomainHash,
        recordTypes,
        values,
        ttls
      );

      // Check the records were set
      for (let i = 0; i < recordTypes.length; i++) {
        const [value, ttl, timestamp] = await resolver.getRecord(testDomainHash, recordTypes[i]);
        expect(value).to.equal(values[i]);
        expect(ttl).to.equal(ttls[i]);
      }
    });

    it('should allow retrieving batch records', async function () {
      const recordTypes = ['A', 'AAAA', 'TXT'];

      const [values, ttls, timestamps] = await resolver.getBatchRecords(testDomainHash, recordTypes);

      expect(values).to.deep.equal(['192.168.1.1', '2001:db8::1', 'Test record']);
      expect(ttls[0]).to.equal(3600);
      expect(ttls[1]).to.equal(3600);
      expect(ttls[2]).to.equal(7200);
    });

    it('should allow retrieving all record types', async function () {
      const types = await resolver.getAllRecordTypes(testDomainHash);

      // Should have 4 record types (A, AAAA, TXT, MX)
      expect(types.length).to.equal(4);
      expect(types).to.include.members(['A', 'AAAA', 'TXT', 'MX']);
    });

    it('should allow bridge to remove records', async function () {
      const tx = await resolver.connect(bridgeWallet).removeRecord(testDomainHash, 'MX');

      await expect(tx)
        .to.emit(resolver, 'RecordRemoved')
        .withArgs(testDomainHash, 'MX');

      const [value, ttl, timestamp] = await resolver.getRecord(testDomainHash, 'MX');
      expect(value).to.equal('');

      // Should now have 3 record types
      const types = await resolver.getAllRecordTypes(testDomainHash);
      expect(types.length).to.equal(3);
      expect(types).to.not.include('MX');
    });

    it('should allow bridge to update bridge address', async function () {
      const tx = await resolver.connect(bridgeWallet).updateBridgeAddress(user1.address);

      await expect(tx)
        .to.emit(resolver, 'BridgeAddressUpdated')
        .withArgs(bridgeWallet.address, user1.address);

      expect(await resolver.bridgeAddress()).to.equal(user1.address);
    });
  });

  // Helper function to get expiry date
  async function getExpiryDate() {
    const renewalPeriod = await registry.renewalPeriod();
    const blockNumBefore = await ethers.provider.getBlockNumber();
    const blockBefore = await ethers.provider.getBlock(blockNumBefore);
    return blockBefore.timestamp + renewalPeriod.toNumber();
  }
});