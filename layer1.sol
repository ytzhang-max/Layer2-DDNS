// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title DDNSRegistry
 * @dev Layer 1 domain registry contract for managing domain ownership and metadata
 */
contract DDNSRegistry {
    // Domain record structure
    struct DomainRecord {
        address owner;           // Domain owner
        bytes32 contentHash;     // IPFS hash pointing to complete records
        uint256 lastUpdated;     // Last update timestamp
        uint256 expiryDate;      // Expiration date
    }

    // Mapping from domain hash to record
    mapping(bytes32 => DomainRecord) public domains;

    // Mapping from address to list of domain hashes (for querying domains owned by a user)
    mapping(address => bytes32[]) private userDomains;

    // Registration fee (can be updated via governance)
    uint256 public registrationFee = 0.01 ether;

    // Renewal period (can be updated via governance)
    uint256 public renewalPeriod = 365 days;

    // Contract owner
    address public owner;

    // Events
    event DomainRegistered(bytes32 indexed domainHash, address indexed owner, uint256 expiryDate);
    event DomainRenewed(bytes32 indexed domainHash, uint256 newExpiryDate);
    event DomainTransferred(bytes32 indexed domainHash, address indexed oldOwner, address indexed newOwner);
    event DomainUpdated(bytes32 indexed domainHash, bytes32 contentHash);
    event RegistrationFeeChanged(uint256 newFee);
    event RenewalPeriodChanged(uint256 newPeriod);

    // Only contract owner modifier
    modifier onlyOwner() {
        require(msg.sender == owner, "DDNSRegistry: caller is not the owner");
        _;
    }

    // Only domain owner modifier
    modifier onlyDomainOwner(bytes32 domainHash) {
        require(domains[domainHash].owner == msg.sender, "DDNSRegistry: caller is not the domain owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @dev Register a new domain
     * @param domainHash The hash of the domain
     */
    function registerDomain(bytes32 domainHash) public payable {
        // Verify domain is not already registered
        require(domains[domainHash].owner == address(0), "DDNSRegistry: domain already registered");

        // Verify payment
        require(msg.value >= registrationFee, "DDNSRegistry: insufficient registration fee");

        // Calculate expiry date
        uint256 expiryDate = block.timestamp + renewalPeriod;

        // Create new domain record
        domains[domainHash] = DomainRecord({
            owner: msg.sender,
            contentHash: bytes32(0),
            lastUpdated: block.timestamp,
            expiryDate: expiryDate
        });

        // Add to user's domain list
        userDomains[msg.sender].push(domainHash);

        // Emit event
        emit DomainRegistered(domainHash, msg.sender, expiryDate);

        // Refund excess payment
        if (msg.value > registrationFee) {
            payable(msg.sender).transfer(msg.value - registrationFee);
        }
    }

    /**
     * @dev Update domain content hash
     * @param domainHash The hash of the domain
     * @param newContentHash The new content hash (pointing to complete records on IPFS)
     */
    function updateDomain(bytes32 domainHash, bytes32 newContentHash) public onlyDomainOwner(domainHash) {
        // Verify domain has not expired
        require(block.timestamp < domains[domainHash].expiryDate, "DDNSRegistry: domain expired");

        // Update content hash and timestamp
        domains[domainHash].contentHash = newContentHash;
        domains[domainHash].lastUpdated = block.timestamp;

        // Emit event
        emit DomainUpdated(domainHash, newContentHash);
    }

    /**
     * @dev Renew a domain
     * @param domainHash The hash of the domain
     */
    function renewDomain(bytes32 domainHash) public payable onlyDomainOwner(domainHash) {
        // Verify payment
        require(msg.value >= registrationFee, "DDNSRegistry: insufficient renewal fee");

        // Update expiry date
        domains[domainHash].expiryDate += renewalPeriod;

        // Emit event
        emit DomainRenewed(domainHash, domains[domainHash].expiryDate);

        // Refund excess payment
        if (msg.value > registrationFee) {
            payable(msg.sender).transfer(msg.value - registrationFee);
        }
    }

    /**
     * @dev Transfer domain ownership
     * @param domainHash The hash of the domain
     * @param newOwner The address of the new owner
     */
    function transferDomain(bytes32 domainHash, address newOwner) public onlyDomainOwner(domainHash) {
        // Verify domain has not expired
        require(block.timestamp < domains[domainHash].expiryDate, "DDNSRegistry: domain expired");

        // Verify new owner is not zero address
        require(newOwner != address(0), "DDNSRegistry: new owner is the zero address");

        // Save old owner
        address oldOwner = domains[domainHash].owner;

        // Update owner
        domains[domainHash].owner = newOwner;
        domains[domainHash].lastUpdated = block.timestamp;

        // Remove from old owner's domain list
        _removeFromUserDomains(oldOwner, domainHash);

        // Add to new owner's domain list
        userDomains[newOwner].push(domainHash);

        // Emit event
        emit DomainTransferred(domainHash, oldOwner, newOwner);
    }

    /**
     * @dev Get domain information
     * @param domainHash The hash of the domain
     * @return owner The owner address
     * @return contentHash The content hash
     * @return lastUpdated The last update timestamp
     * @return expiryDate The expiration date
     */
    function getDomain(bytes32 domainHash) public view returns (address, bytes32, uint256, uint256) {
        DomainRecord memory record = domains[domainHash];
        return (record.owner, record.contentHash, record.lastUpdated, record.expiryDate);
    }

    /**
     * @dev Get all domains owned by a user
     * @param user The user address
     * @return Array of domain hashes
     */
    function getUserDomains(address user) public view returns (bytes32[] memory) {
        return userDomains[user];
    }

    /**
     * @dev Remove a domain from a user's domain list
     * @param user The user address
     * @param domainHash The domain hash
     */
    function _removeFromUserDomains(address user, bytes32 domainHash) private {
        bytes32[] storage userDomainList = userDomains[user];
        for (uint256 i = 0; i < userDomainList.length; i++) {
            if (userDomainList[i] == domainHash) {
                // Move the last element to the position of the element to delete
                userDomainList[i] = userDomainList[userDomainList.length - 1];
                // Remove the last element
                userDomainList.pop();
                break;
            }
        }
    }

    /**
     * @dev Update registration fee (only contract owner)
     * @param newFee The new registration fee
     */
    function setRegistrationFee(uint256 newFee) public onlyOwner {
        registrationFee = newFee;
        emit RegistrationFeeChanged(newFee);
    }

    /**
     * @dev Update renewal period (only contract owner)
     * @param newPeriod The new renewal period (in seconds)
     */
    function setRenewalPeriod(uint256 newPeriod) public onlyOwner {
        renewalPeriod = newPeriod;
        emit RenewalPeriodChanged(newPeriod);
    }

    /**
     * @dev Withdraw contract balance (only contract owner)
     */
    function withdraw() public onlyOwner {
        payable(owner).transfer(address(this).balance);
    }

    /**
     * @dev Calculate domain hash utility method (can be called from frontend)
     * @param domainName Domain name string
     * @return keccak256 hash of the domain
     */
    function calculateDomainHash(string calldata domainName) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(domainName));
    }
}