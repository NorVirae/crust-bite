// Enhanced Pi Network Sweeper Bot with Test Mode and Proper Error Handling
// Includes test mode, better error detection, and rate limit handling

import * as ed25519 from 'ed25519-hd-key';
import StellarSdk, { TimeoutInfinite } from 'stellar-sdk';
import * as bip39 from 'bip39';

// Enhanced Configuration
const config = {
    horizonUrl: 'https://api.mainnet.minepi.com',
    networkPassphrase: 'Pi Network',
    
    // Test Mode Configuration
    testMode: false,                // Set to false for production
    testModeSkipWait: false,        // Skip waiting for unlock time in test mode
    testModeMaxAttempts: 2,        // Fewer attempts in test mode
    
    // Fee Strategy Configuration
    baseFee: 10000000,             // 1 PI - start higher
    maxFee: 500000000,             // 50 PI - willing to go very high
    feePriorityMultiplier: 3.5,    // aggressive fee bumping
    dynamicFeeMultiplier: 5,       // multiply network p99 by this
    
    // Timing Strategy
    maxSubmissionAttempts: 20,     // more attempts
    retryDelay: 50,                // ms between retries
    timeboundGrace: 30,            // tighter window
    preClaimWindow: 500,           // ms before unlock time to start trying
    
    // Rate Limit Handling
    rateLimitDelay: 5000,          // 5 seconds delay on rate limit
    rateLimitBackoff: 2,           // exponential backoff multiplier
    maxRateLimitRetries: 5,        // max retries for rate limited requests
    
    // Flooding Strategy
    floodCount: 10,                // more duplicate submissions
    floodInterval: 50,             // faster flooding
    parallelSubmissions: 5,        // submit multiple at once
    
    // Competition Detection
    monitorInterval: 2000,         // ms - increased to avoid rate limits
    competitorDetection: true,     // detect other bots' patterns
    
    // Advanced Strategies
    useRandomFees: true,           // add randomness to fees to confuse competitors
    feeRandomRange: 0.2,           // ±20% randomness
    useBurstMode: true,            // rapid-fire submissions near unlock
    burstCount: 50,                // submissions in burst mode
    burstInterval: 10,             // ms between burst submissions
    
    debug: true,
};

class EnhancedPiSweeperBot {
    constructor(targetMnemonic, destination, sponsorMnemonic) {
        this.dest = destination;
        this.targetKP = this.mnemonicToKeypair(targetMnemonic);
        this.sponsorKP = this.mnemonicToKeypair(sponsorMnemonic);
        this.server = new StellarSdk.Server(config.horizonUrl, { allowHttp: false });
        this.network = config.networkPassphrase;
        this.currentFee = config.baseFee;
        this.competitorActivity = new Map();
        this.claimedBalances = new Set();
        this.pendingTransactions = new Map();
        this.rateLimitBackoffTime = config.rateLimitDelay;
        
        this.claimableUrl = `${config.horizonUrl}/claimable_balances?claimant=${this.targetKP.publicKey()}`;
        this.log(`Enhanced Bot Initialized ${config.testMode ? '(TEST MODE)' : '(PRODUCTION MODE)'}`);
        this.log(`Target: ${this.targetKP.publicKey()}`);
        this.log(`Sponsor: ${this.sponsorKP.publicKey()}`);
        this.log(`Destination: ${this.dest}`);
        this.log(`Check balances: ${this.claimableUrl}`);
    }

    log(msg, level = 'INFO') {
        if (config.debug) {
            const timestamp = new Date().toISOString();
            const prefix = config.testMode ? '[TEST]' : '[PROD]';
            console.log(`${prefix}[${timestamp}][${level}] ${msg}`);
        }
    }

    mnemonicToKeypair(mnemonic) {
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        const path = "m/44'/314159'/0'";
        const { key } = ed25519.derivePath(path, seed.toString('hex'));
        return StellarSdk.Keypair.fromRawEd25519Seed(Buffer.from(key));
    }

    // Parse transaction result to determine actual success/failure
    parseTransactionResult(result) {
        // Check if result has error indicators
        if (result.title && result.title.includes("Failed")) {
            return {
                success: false,
                reason: result.extras?.result_codes || result.title,
                hash: result.hash || null
            };
        }

        // Check for successful hash
        if (result.hash && !result.extras?.result_codes?.transaction) {
            return {
                success: true,
                hash: result.hash
            };
        }

        // Check result codes
        if (result.extras?.result_codes) {
            const txCode = result.extras.result_codes.transaction;
            const opCodes = result.extras.result_codes.operations;
            
            if (txCode === 'tx_success' && opCodes?.every(code => code === 'op_success')) {
                return {
                    success: true,
                    hash: result.hash
                };
            } else {
                return {
                    success: false,
                    reason: `TX: ${txCode}, OPS: ${opCodes?.join(', ')}`,
                    hash: result.hash
                };
            }
        }

        // Default to failure if we can't determine
        return {
            success: false,
            reason: 'Unknown result format',
            hash: result.hash || null
        };
    }

    // Handle rate limiting with exponential backoff
    async handleRateLimit(func, context = 'operation') {
        let retries = 0;
        let delay = this.rateLimitBackoffTime;
        
        while (retries < config.maxRateLimitRetries) {
            try {
                return await func();
            } catch (err) {
                if (err.message && err.message.includes('Too Many Requests')) {
                    retries++;
                    this.log(`Rate limited on ${context} (retry ${retries}/${config.maxRateLimitRetries}). Waiting ${delay}ms...`, 'WARN');
                    await new Promise(res => setTimeout(res, delay));
                    delay *= config.rateLimitBackoff;
                } else {
                    throw err;
                }
            }
        }
        throw new Error(`Max rate limit retries exceeded for ${context}`);
    }

    // Enhanced fee calculation with randomness
    calculateCompetitiveFee() {
        let fee = this.currentFee;
        
        if (config.useRandomFees) {
            const randomFactor = 1 + (Math.random() - 0.5) * config.feeRandomRange;
            fee = Math.floor(fee * randomFactor);
        }
        
        return Math.min(fee, config.maxFee);
    }

    // Fetch all claimable balances with rate limit handling
    async getAllBalances() {
        return this.handleRateLimit(async () => {
            const resp = await this.server
                .claimableBalances()
                .claimant(this.targetKP.publicKey())
                .limit(200)
                .call();
            
            const balances = resp.records.filter(bal => !this.claimedBalances.has(bal.id));
            
            if (config.testMode && balances.length > 0) {
                this.log(`Test Mode: Found ${balances.length} balances:`, 'TEST');
                balances.forEach(bal => {
                    const unlockTime = this.extractMinTime(bal);
                    const now = Date.now() / 1000;
                    this.log(`  - ID: ${bal.id.substring(0, 16)}... Amount: ${bal.amount} PI, Unlocks in: ${unlockTime - now}s`, 'TEST');
                });
            }
            
            return balances;
        }, 'getAllBalances');
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

    // Test mode transaction builder
    async buildTestTransaction(balanceId, amount, balance) {
        const fee = this.calculateCompetitiveFee();
        const unlockTime = this.extractMinTime(balance);
        
        // In test mode, use wider time bounds to ensure transaction is valid
        const lowerBound = Math.floor(Date.now() / 1000);
        const upperBound = config.testMode ? 
            Math.floor((Date.now() / 1000) + 3600) : // 1 hour window for testing
            Math.floor(unlockTime + config.timeboundGrace);
        
        this.log(`Test TX: Lower bound: ${lowerBound}, Upper bound: ${upperBound}, Fee: ${fee}`, 'TEST');
        
        const sponsorAcc = await this.handleRateLimit(
            async () => await this.server.loadAccount(this.sponsorKP.publicKey()),
            'loadAccount'
        );
        
        const tx = new StellarSdk.TransactionBuilder(sponsorAcc, {
            fee: String(fee),
            networkPassphrase: this.network,
        })
        .addOperation(StellarSdk.Operation.claimClaimableBalance({
            balanceId,
            source: this.targetKP.publicKey(),
        }))
        .addOperation(StellarSdk.Operation.payment({
            destination: this.dest,
            asset: StellarSdk.Asset.native(),
            amount: String(amount),
            source: this.targetKP.publicKey(),
        }))
        .setTimebounds(lowerBound, upperBound)
        .build();
        
        tx.sign(this.targetKP);
        tx.sign(this.sponsorKP);
        
        return { tx, fee };
    }

    // Test a single transaction submission
    async testSingleSubmission(balance) {
        this.log('=== STARTING TEST SUBMISSION ===', 'TEST');
        
        try {
            const { tx, fee } = await this.buildTestTransaction(balance.id, balance.amount, balance);
            
            this.log(`Submitting test transaction with fee: ${fee}`, 'TEST');
            this.log(`Transaction XDR: ${tx.toXDR()}`, 'TEST');
            
            const result = await this.handleRateLimit(
                async () => await this.server.submitTransaction(tx),
                'submitTransaction'
            );
            
            this.log(`Raw result: ${JSON.stringify(result, null, 2)}`, 'TEST');
            
            const parsed = this.parseTransactionResult(result);
            
            if (parsed.success) {
                this.log(`TEST SUCCESS! Hash: ${parsed.hash}`, 'TEST');
            } else {
                this.log(`TEST FAILED! Reason: ${parsed.reason}`, 'TEST');
                this.log(`This is expected if the balance is still locked.`, 'TEST');
            }
            
            return parsed;
            
        } catch (err) {
            this.log(`TEST ERROR: ${err.message}`, 'ERROR');
            if (err.response && err.response.data) {
                this.log(`Error details: ${JSON.stringify(err.response.data, null, 2)}`, 'ERROR');
            }
            return { success: false, reason: err.message };
        }
    }

    // Build multiple transactions with different fees for parallel submission
    async buildMultipleTxVersions(balanceId, amount, balance, count = 3) {
        const transactions = [];
        const baseFee = this.calculateCompetitiveFee();
        
        for (let i = 0; i < count; i++) {
            try {
                const fee = Math.floor(baseFee * (1 + i * 0.5));
                const unlockTime = this.extractMinTime(balance);
                
                const lowerBound = Math.floor((Date.now() + 100) / 1000);
                const upperBound = Math.floor(unlockTime + config.timeboundGrace);
                
                if (lowerBound >= upperBound && !config.testMode) continue;
                
                const sponsorAcc = await this.handleRateLimit(
                    async () => await this.server.loadAccount(this.sponsorKP.publicKey()),
                    'loadAccount'
                );
                
                const tx = new StellarSdk.TransactionBuilder(sponsorAcc, {
                    fee: String(fee),
                    networkPassphrase: this.network,
                })
                .addOperation(StellarSdk.Operation.claimClaimableBalance({
                    balanceId,
                    source: this.targetKP.publicKey(),
                }))
                .addOperation(StellarSdk.Operation.payment({
                    destination: this.dest,
                    asset: StellarSdk.Asset.native(),
                    amount: String(amount),
                    source: this.targetKP.publicKey(),
                }))
                .setTimebounds(lowerBound, upperBound)
                .build();
                
                tx.sign(this.targetKP);
                tx.sign(this.sponsorKP);
                
                transactions.push({ tx, fee });
            } catch (err) {
                this.log(`Error building tx variant ${i}: ${err.message}`, 'ERROR');
            }
        }
        
        return transactions;
    }

    // Main claiming logic with proper error handling
    async claimBalance(balance) {
        const id = balance.id;
        const amt = balance.amount;
        const unlockTime = this.extractMinTime(balance);
        const now = Date.now() / 1000;
        
        this.log(`Processing balance ${id} (${amt} PI) - unlocks in ${unlockTime - now}s`);
        
        // In test mode, run a single test
        if (config.testMode) {
            return await this.testSingleSubmission(balance);
        }
        
        // Production mode - wait for unlock time
        if (!config.testModeSkipWait && unlockTime > now + 1) {
            const waitTime = (unlockTime - now - config.preClaimWindow / 1000) * 1000;
            if (waitTime > 0) {
                this.log(`Waiting ${waitTime}ms until optimal claim window`);
                await new Promise(res => setTimeout(res, waitTime));
            }
        }
        
        // Build multiple transaction versions
        const txVersions = await this.buildMultipleTxVersions(id, amt, balance, 5);
        
        if (txVersions.length === 0) {
            this.log(`Failed to build any valid transactions for ${id}`, 'ERROR');
            return false;
        }
        
        // Try burst mode if enabled
        if (config.useBurstMode && unlockTime - Date.now() / 1000 < 2) {
            try {
                this.log(`Entering BURST MODE for ${id}`);
                const result = await this.burstSubmit(txVersions);
                if (result.success) {
                    this.claimedBalances.add(id);
                    return true;
                }
            } catch (err) {
                this.log(`Burst mode failed: ${err.message}`, 'WARN');
            }
        }
        
        // Progressive fee bumping
        let attempt = 0;
        const maxAttempts = config.testMode ? config.testModeMaxAttempts : config.maxSubmissionAttempts;
        
        while (attempt < maxAttempts) {
            try {
                await this.updateFeeStats();
                
                // Submit multiple versions in parallel
                const submissions = txVersions.slice(0, config.parallelSubmissions).map(({ tx, fee }) => 
                    this.handleRateLimit(
                        async () => {
                            const result = await this.server.submitTransaction(tx);
                            const parsed = this.parseTransactionResult(result);
                            return { ...parsed, fee };
                        },
                        'submitTransaction'
                    ).catch(err => ({ success: false, err, fee }))
                );
                
                const results = await Promise.all(submissions);
                const success = results.find(r => r.success);
                
                if (success) {
                    this.log(`SUCCESS! Claimed ${id} with fee ${success.fee}, hash: ${success.hash}`);
                    this.claimedBalances.add(id);
                    
                    if (!config.testMode) {
                        this.floodNetwork(txVersions[0].tx);
                    }
                    
                    return true;
                }
                
                // Log failure reasons
                results.forEach((r, i) => {
                    if (!r.success) {
                        this.log(`Attempt ${attempt + 1}, submission ${i + 1} failed: ${r.reason || r.err?.message}`, 'WARN');
                    }
                });
                
                // Bump fees
                this.currentFee = Math.floor(this.currentFee * config.feePriorityMultiplier);
                this.log(`Bumping fee to ${this.currentFee}`);
                
                // Rebuild transactions with new fees
                txVersions.length = 0;
                txVersions.push(...await this.buildMultipleTxVersions(id, amt, balance, 5));
                
            } catch (err) {
                this.log(`Critical error in attempt ${attempt + 1}: ${err.message}`, 'ERROR');
            }
            
            attempt++;
            if (attempt < maxAttempts) {
                await new Promise(res => setTimeout(res, config.retryDelay));
            }
        }
        
        return false;
    }

    // Burst submission with proper error handling
    async burstSubmit(transactions) {
        const promises = [];
        
        for (let i = 0; i < config.burstCount; i++) {
            for (const { tx, fee } of transactions) {
                promises.push(
                    this.handleRateLimit(
                        async () => {
                            const result = await this.server.submitTransaction(tx);
                            const parsed = this.parseTransactionResult(result);
                            if (parsed.success) {
                                this.log(`Burst success with fee ${fee}: ${parsed.hash}`);
                            }
                            return { ...parsed, fee };
                        },
                        'burstSubmit'
                    ).catch(err => ({ success: false, err, fee }))
                );
                
                if (i < config.burstCount - 1) {
                    await new Promise(res => setTimeout(res, config.burstInterval));
                }
            }
        }
        
        const results = await Promise.all(promises);
        const success = results.find(r => r.success);
        
        if (success) {
            return success;
        }
        
        throw new Error('All burst submissions failed');
    }

    // Flood network with successful transaction
    async floodNetwork(tx) {
        if (config.testMode) return; // Skip flooding in test mode
        
        const promises = [];
        for (let i = 0; i < config.floodCount; i++) {
            promises.push(
                new Promise(res => {
                    setTimeout(() => {
                        this.server.submitTransaction(tx).catch(() => {});
                        res();
                    }, i * config.floodInterval);
                })
            );
        }
        await Promise.all(promises);
    }

    // Update fee statistics with rate limit handling
    async updateFeeStats() {
        try {
            const stats = await this.handleRateLimit(
                async () => await this.server.feeStats(),
                'feeStats'
            );
            
            const p99 = parseInt(stats.fee_charged.p99, 10);
            let competitiveFee = p99 * config.dynamicFeeMultiplier;
            this.currentFee = Math.max(competitiveFee, config.baseFee);
            
            this.log(`Fee updated: ${this.currentFee} stroops (network p99: ${p99})`);
        } catch (err) {
            this.log(`Failed to update fee stats: ${err.message}`, 'WARN');
        }
    }

    // Test mode runner
    async runTestMode() {
        this.log('=== RUNNING IN TEST MODE ===', 'TEST');
        this.log('This will attempt to submit a transaction to test connectivity and configuration.', 'TEST');
        this.log('The transaction may fail if the balance is still locked - this is expected.', 'TEST');
        
        try {
            // Test fee stats
            this.log('Testing fee stats endpoint...', 'TEST');
            await this.updateFeeStats();
            this.log('✓ Fee stats working', 'TEST');
            
            // Test balance fetching
            this.log('Testing balance fetching...', 'TEST');
            const balances = await this.getAllBalances();
            this.log(`✓ Found ${balances.length} balances`, 'TEST');
            
            if (balances.length === 0) {
                this.log('No balances found to test. Waiting for balances...', 'TEST');
                return;
            }
            
            // Test transaction submission on first balance
            const testBalance = balances[0];
            this.log(`Testing transaction submission on balance ${testBalance.id}...`, 'TEST');
            await this.claimBalance(testBalance);
            
            this.log('=== TEST MODE COMPLETE ===', 'TEST');
            
        } catch (err) {
            this.log(`Test mode error: ${err.message}`, 'ERROR');
            if (err.stack) {
                this.log(`Stack trace: ${err.stack}`, 'ERROR');
            }
        }
    }

    // Main loop
    async start() {
        this.log(`Starting enhanced sweeper bot in ${config.testMode ? 'TEST' : 'PRODUCTION'} mode...`);
        
        // Initial setup
        await this.updateFeeStats();
        
        // Run test mode if enabled
        if (config.testMode) {
            await this.runTestMode();
            this.log('Test mode complete. Set testMode to false for production.', 'TEST');
            return;
        }
        
        // Production loop
        while (true) {
            try {
                const balances = await this.getAllBalances();
                
                if (balances.length === 0) {
                    await new Promise(res => setTimeout(res, config.monitorInterval));
                    continue;
                }
                
                this.log(`Found ${balances.length} claimable balances`);
                
                // Sort by unlock time
                balances.sort((a, b) => {
                    const timeA = this.extractMinTime(a);
                    const timeB = this.extractMinTime(b);
                    return timeA - timeB;
                });
                
                // Process balances
                for (const balance of balances) {
                    await this.claimBalance(balance);
                }
                
            } catch (err) {
                this.log(`Error in main loop: ${err.message}`, 'ERROR');
                await new Promise(res => setTimeout(res, 5000));
            }
        }
    }
}

// Entry point
(async () => {
    const target = 'people flag blossom box ivory oxygen eye what decorate license donkey hello spoil praise arm scrub estate grant way accident dad manual poet magic';
    const sponsor = 'cute increase lab raw blade lawsuit soon congress title flat brown smoke hair hard property copper limit regular process remember use safe yellow quantum';
    const dest = 'GAHQMFHVA7EKDD54L4HBX4QNCTGCLVTCP5DXKKFSTEBTQBNG6WDVGLCR';
    
    const bot = new EnhancedPiSweeperBot(target, dest, sponsor);
    await bot.start();
})();