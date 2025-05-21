Getting Started
Prerequisites
Node.js v16+
Hardhat
Ethereum wallet with testnet ETH (for Sepolia)
Optimism testnet access (Goerli)
Installation
Clone the repository:

bash

git clone https://github.com/yourusername/layer2-ddns.git
cd layer2-ddns
Install dependencies:

bash

npm install
Set up environment variables:

bash

cp .env.example .env
# Edit .env with your API keys and private key
Deployment
Deploy contracts to testnets:

bash

# Deploy to Layer 1 (Sepolia)
npx hardhat run scripts/deploy-l1.js --network sepolia

# Deploy to Layer 2 (Optimism Goerli)
npx hardhat run scripts/deploy-l2.js --network optimismGoerli
Update configuration:

bash

# Update config.js with the deployed contract addresses
Start the bridge service:

bash

npm run bridge
