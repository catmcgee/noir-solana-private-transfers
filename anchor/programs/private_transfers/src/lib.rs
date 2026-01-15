use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;

declare_id!("2QRZu5cWy8x8jEFc9nhsnrnQSMAKwNpiLpCXrMRb3oUn");

// TODO (Step 5): Add Sunspot verifier program ID
// TODO (Step 3): Add Merkle tree constants (TREE_DEPTH, ROOT_HISTORY_SIZE)

pub const MIN_DEPOSIT_AMOUNT: u64 = 1_000_000; // 0.001 SOL

#[program]
pub mod private_transfers {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.total_deposits = 0;

        // TODO (Step 3): Initialize root history

        msg!("Pool initialized");
        Ok(())
    }

    // STARTER: Public deposit - NO PRIVACY
    // Anyone watching the blockchain can see WHO deposited and HOW MUCH
    pub fn deposit(
        ctx: Context<Deposit>,
        // TODO (Step 1): Add commitment: [u8; 32]
        // TODO (Step 3): Add new_root: [u8; 32]
        amount: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;

        require!(
            amount >= MIN_DEPOSIT_AMOUNT,
            PrivateTransfersError::DepositTooSmall
        );

        // Transfer SOL from depositor to vault
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.depositor.key(),
            &ctx.accounts.pool_vault.key(),
            amount,
        );

        invoke(
            &transfer_ix,
            &[
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.pool_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // TODO (Step 3): Update root history

        // PROBLEM: Everyone can see exactly who deposited!
        emit!(DepositEvent {
            depositor: ctx.accounts.depositor.key(), // TODO (Step 1): Replace with commitment
            amount,
            timestamp: Clock::get()?.unix_timestamp,
            // TODO (Step 1): Add leaf_index
            // TODO (Step 3): Add new_root
        });

        pool.total_deposits += 1;
        // TODO (Step 1): Increment next_leaf_index

        msg!("Public deposit: {} lamports from {}", amount, ctx.accounts.depositor.key());
        Ok(())
    }

    // STARTER: Public withdraw - NO PRIVACY
    // Anyone watching the blockchain can see WHO withdrew
    pub fn withdraw(
        ctx: Context<Withdraw>,
        // TODO (Step 5): Add proof: Vec<u8>
        // TODO (Step 2): Add nullifier_hash: [u8; 32]
        // TODO (Step 3): Add root: [u8; 32]
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
        // TODO (Step 2): Check nullifier not used
        // TODO (Step 3): Validate root is known

        // Prevents front-running by binding to recipient
        require!(
            ctx.accounts.recipient.key() == recipient,
            PrivateTransfersError::RecipientMismatch
        );

        require!(
            ctx.accounts.pool_vault.lamports() >= amount,
            PrivateTransfersError::InsufficientVaultBalance
        );

        // TODO (Step 5): Verify ZK proof via CPI to Sunspot
        // TODO (Step 2): Mark nullifier as used

        // Transfer SOL from vault to recipient
        let pool = &ctx.accounts.pool;
        let pool_key = pool.key();
        let seeds = &[b"vault".as_ref(), pool_key.as_ref(), &[ctx.bumps.pool_vault]];

        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.pool_vault.key(),
                &ctx.accounts.recipient.key(),
                amount,
            ),
            &[
                ctx.accounts.pool_vault.to_account_info(),
                ctx.accounts.recipient.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;

        // PROBLEM: Everyone can see who withdrew!
        emit!(WithdrawEvent {
            recipient: ctx.accounts.recipient.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
            // TODO (Step 2): Add nullifier_hash
        });

        msg!("Public withdrawal: {} lamports to {}", amount, recipient);
        Ok(())
    }
}

// TODO (Step 5): Add encode_public_inputs function for Gnark witness format

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool"],
        bump
    )]
    pub pool: Account<'info, Pool>,

    // TODO (Step 2): Add NullifierSet account

    /// CHECK: PDA validated by seeds
    #[account(seeds = [b"vault", pool.key().as_ref()], bump)]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [b"pool"], bump)]
    pub pool: Account<'info, Pool>,

    /// CHECK: PDA validated by seeds
    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds = [b"pool"], bump)]
    pub pool: Account<'info, Pool>,

    // TODO (Step 2): Add NullifierSet account

    /// CHECK: PDA validated by seeds
    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
    pub pool_vault: UncheckedAccount<'info>,

    /// CHECK: Validated in instruction logic
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    // TODO (Step 5): Add Sunspot verifier program account

    pub system_program: Program<'info, System>,
}

// STARTER: Basic Pool - no privacy features yet
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Pubkey,
    pub total_deposits: u64,
    // TODO (Step 1): Add next_leaf_index: u64
    // TODO (Step 3): Add current_root_index: u64
    // TODO (Step 3): Add roots: [[u8; 32]; ROOT_HISTORY_SIZE]
}

// TODO (Step 3): Add is_known_root method to Pool
// TODO (Step 2): Add NullifierSet account struct

// STARTER: Events show PUBLIC information - no privacy!
#[event]
pub struct DepositEvent {
    pub depositor: Pubkey, // TODO (Step 1): Replace with commitment: [u8; 32]
    pub amount: u64,
    pub timestamp: i64,
    // TODO (Step 1): Add leaf_index: u64
    // TODO (Step 3): Add new_root: [u8; 32]
}

#[event]
pub struct WithdrawEvent {
    pub recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
    // TODO (Step 2): Add nullifier_hash: [u8; 32]
}

#[error_code]
pub enum PrivateTransfersError {
    #[msg("Deposit amount too small (minimum 0.001 SOL)")]
    DepositTooSmall,
    #[msg("Recipient account does not match recipient parameter")]
    RecipientMismatch,
    #[msg("Insufficient vault balance for withdrawal")]
    InsufficientVaultBalance,
    // TODO (Step 1): Add TreeFull
    // TODO (Step 2): Add NullifierUsed, NullifierSetFull
    // TODO (Step 3): Add InvalidRoot
    // TODO (Step 5): Add InvalidVerifier
}
