// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title DDNSResolver
 * @dev Layer 2 domain resolver contract for efficient DNS record queries
 */
contract DDNSResolver {
    // DNS record structure
    struct DNSRecord {
        string recordType;   // Record type ("A", "AAAA", "TXT", etc.)
        string value;        // Record value
        uint256 ttl;         // Time to live (seconds)
        uint256 timestamp;   // Update timestamp
    }

    // Domain hash -> Record type -> Record
    mapping(bytes32 => mapping(string => DNSRecord)) public records;

    // Domain hash -> Record types list (for iterating all records)
    mapping(bytes32 => string[]) private recordTypes;

    // Bridge contract address (authorized to update records)
    address public bridgeAddress;

    // Events
    event RecordSet(bytes32 indexed domainHash, string recordType, string value, uint256 ttl);
    event RecordRemoved(bytes32 indexed domainHash, string recordType);
    event BridgeAddressUpdated(address indexed oldBridge, address indexed newBridge);

    // Only bridge contract can call modifier
    modifier onlyBridge() {
        require(msg.sender == bridgeAddress, "DDNSResolver: caller is not the bridge");
        _;
    }

    constructor(address _bridgeAddress) {
        bridgeAddress = _bridgeAddress;
    }

    /**
     * @dev Set DNS record (only bridge contract can call)
     * @param domainHash The hash of the domain
     * @param recordType Record type ("A", "AAAA", "TXT", etc.)
     * @param value Record value
     * @param ttl Time to live (seconds)
     */
    function setRecord(
        bytes32 domainHash,
        string calldata recordType,
        string calldata value,
        uint256 ttl
    ) external onlyBridge {
        // Check if record type already exists
        bool exists = bytes(records[domainHash][recordType].value).length > 0;

        // Store record
        records[domainHash][recordType] = DNSRecord({
            recordType: recordType,
            value: value,
            ttl: ttl,
            timestamp: block.timestamp
        });

        // If it's a new record type, add to types list
        if (!exists) {
            recordTypes[domainHash].push(recordType);
        }

        // Emit event
        emit RecordSet(domainHash, recordType, value, ttl);
    }

    /**
     * @dev Batch set DNS records (only bridge contract can call)
     * @param domainHash The hash of the domain
     * @param _recordTypes Array of record types
     * @param values Array of record values
     * @param ttls Array of TTLs
     */
    function setBatchRecords(
        bytes32 domainHash,
        string[] calldata _recordTypes,
        string[] calldata values,
        uint256[] calldata ttls
    ) external onlyBridge {
        // Verify arrays have the same length
        require(
            _recordTypes.length == values.length && _recordTypes.length == ttls.length,
            "DDNSResolver: array lengths do not match"
        );

        // Batch set records
        for (uint256 i = 0; i < _recordTypes.length; i++) {
            setRecord(domainHash, _recordTypes[i], values[i], ttls[i]);
        }
    }

    /**
     * @dev Remove DNS record (only bridge contract can call)
     * @param domainHash The hash of the domain
     * @param recordType Record type
     */
    function removeRecord(bytes32 domainHash, string calldata recordType) external onlyBridge {
        // Ensure record exists
        require(bytes(records[domainHash][recordType].value).length > 0, "DDNSResolver: record does not exist");

        // Delete record
        delete records[domainHash][recordType];

        // Remove from types list
        _removeRecordType(domainHash, recordType);

        // Emit event
        emit RecordRemoved(domainHash, recordType);
    }

    /**
     * @dev Get single DNS record
     * @param domainHash The hash of the domain
     * @param recordType Record type
     * @return value Record value
     * @return ttl Time to live
     * @return timestamp Update timestamp
     */
    function getRecord(bytes32 domainHash, string calldata recordType)
        external view returns (string memory value, uint256 ttl, uint256 timestamp) {
        DNSRecord memory record = records[domainHash][recordType];
        return (record.value, record.ttl, record.timestamp);
    }

    /**
     * @dev Batch get DNS records
     * @param domainHash The hash of the domain
     * @param _recordTypes Array of record types
     * @return values Array of record values
     * @return ttls Array of TTLs
     * @return timestamps Array of update timestamps
     */
    function getBatchRecords(bytes32 domainHash, string[] calldata _recordTypes)
        external view returns (string[] memory values, uint256[] memory ttls, uint256[] memory timestamps) {

        values = new string[](_recordTypes.length);
        ttls = new uint256[](_recordTypes.length);
        timestamps = new uint256[](_recordTypes.length);

        for (uint256 i = 0; i < _recordTypes.length; i++) {
            DNSRecord memory record = records[domainHash][_recordTypes[i]];
            values[i] = record.value;
            ttls[i] = record.ttl;
            timestamps[i] = record.timestamp;
        }

        return (values, ttls, timestamps);
    }

    /**
     * @dev Get all record types for a domain
     * @param domainHash The hash of the domain
     * @return Array of record types
     */
    function getAllRecordTypes(bytes32 domainHash) external view returns (string[] memory) {
        return recordTypes[domainHash];
    }

    /**
     * @dev Get all records for a domain
     * @param domainHash The hash of the domain
     * @return types Array of record types
     * @return values Array of record values
     * @return ttls Array of TTLs
     */
    function getAllRecords(bytes32 domainHash)
        external view returns (string[] memory types, string[] memory values, uint256[] memory ttls) {

        string[] memory _recordTypes = recordTypes[domainHash];

        values = new string[](_recordTypes.length);
        ttls = new uint256[](_recordTypes.length);

        for (uint256 i = 0; i < _recordTypes.length; i++) {
            DNSRecord memory record = records[domainHash][_recordTypes[i]];
            values[i] = record.value;
            ttls[i] = record.ttl;
        }

        return (_recordTypes, values, ttls);
    }

    /**
     * @dev Update bridge contract address (only current bridge can call)
     * @param newBridgeAddress The new bridge contract address
     */
    function updateBridgeAddress(address newBridgeAddress) external onlyBridge {
        require(newBridgeAddress != address(0), "DDNSResolver: new bridge is the zero address");

        address oldBridge = bridgeAddress;
        bridgeAddress = newBridgeAddress;

        emit BridgeAddressUpdated(oldBridge, newBridgeAddress);
    }

    /**
     * @dev Remove a record type from the types list
     * @param domainHash The hash of the domain
     * @param recordType Record type
     */
    function _removeRecordType(bytes32 domainHash, string memory recordType) private {
        string[] storage types = recordTypes[domainHash];
        for (uint256 i = 0; i < types.length; i++) {
            if (keccak256(bytes(types[i])) == keccak256(bytes(recordType))) {
                // Move the last element to the position of the element to delete
                types[i] = types[types.length - 1];
                // Remove the last element
                types.pop();
                break;
            }
        }
    }
}