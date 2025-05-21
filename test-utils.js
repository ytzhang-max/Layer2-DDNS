// test-utils.js - Testing utilities
const { ethers } = require('hardhat');
const IPFS = require('ipfs-http-client');

/**
 * Deploy contracts for testing
 * @returns {Promise<Object>} Deployed contracts
 */
async function deployContracts() {
  // Get signers
  const [owner, bridgeWallet, user1, user2] = await ethers.getSigners();

  // Deploy L1 Registry
  const DDNSRegistry = await ethers.getContractFactory('DDNSRegistry');
  const registry = await DDNSRegistry.deploy();
  await registry.deployed();

  // Deploy L2 Resolver (using bridgeWallet as bridge address)
  const DDNSResolver = await ethers.getContractFactory('DDNSResolver');
  const resolver = await DDNSResolver.deploy(bridgeWallet.address);
  await resolver.deployed();

  return {
    registry,
    resolver,
    owner,
    bridgeWallet,
    user1,
    user2
  };
}

/**
 * Create mock IPFS records
 * @param {string} domain Domain name
 * @param {Object} records DNS records object
 * @returns {Promise<string>} Content hash
 */
async function createMockIPFSRecords(domain, records) {
  // In a real test, this would upload to IPFS and return the hash
  // For the test, we'll just return a mock hash

  const data = {
    domain,
    records,
    ttl: 3600,
    timestamp: Math.floor(Date.now() / 1000)
  };

  // Create a deterministic mock hash based on domain
  const mockHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(JSON.stringify(data)));

  // Return a properly formatted content hash
  return mockHash;
}

/**
 * Helper to calculate domain hash
 * @param {string} domainName Domain name
 * @returns {string} Domain hash
 */
function calculateDomainHash(domainName) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(domainName));
}

/**
 * Wait for a specified time
 * @param {number} ms Milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  deployContracts,
  createMockIPFSRecords,
  calculateDomainHash,
  sleep
};