import { useState, useEffect } from 'react'
import { useWalletConnection, useSendTransaction } from '@solana/react-hooks'
import { address, getProgramDerivedAddress, getBytesEncoder, getAddressEncoder } from '@solana/kit'
import { getWithdrawInstructionDataEncoder, PRIVATE_TRANSFERS_PROGRAM_ADDRESS } from '../generated'
import { getWalletAddress, hexToBytes, formatSol } from '../utils'
import { API_URL, SEEDS, SYSTEM_PROGRAM_ID, SUNSPOT_VERIFIER_ID, COMPUTE_BUDGET_PROGRAM_ID, ZK_VERIFY_COMPUTE_UNITS } from '../constants'
import type { DepositNote, WithdrawApiResponse } from '../types'

interface WithdrawSectionProps {
  depositNote: DepositNote | null
}

export function WithdrawSection({ depositNote }: WithdrawSectionProps) {
  const { wallet } = useWalletConnection()
  const { send: sendTransaction, isSending } = useSendTransaction()
  const [recipient, setRecipient] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)

  const walletAddress = getWalletAddress(wallet)

  useEffect(() => {
    if (walletAddress && !recipient) {
      setRecipient(walletAddress)
    }
  }, [walletAddress, recipient])

  const handleWithdraw = async () => {
    if (!walletAddress || !wallet || !depositNote || !recipient) return

    setLoading(true)
    setStatus('Generating ZK proof (this may take ~30 seconds)...')

    try {
      const response = await fetch(`${API_URL}/api/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ depositNote, recipient, payer: walletAddress })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to generate proof')
      }

      const { withdrawalProof }: WithdrawApiResponse = await response.json()

      console.log('[Withdraw] Proof generated:', withdrawalProof.proof.length, 'bytes')

      setStatus('Submitting withdrawal to blockchain...')

      const proof = new Uint8Array(withdrawalProof.proof)
      const nullifierHash = hexToBytes(withdrawalProof.nullifierHash)
      const root = hexToBytes(withdrawalProof.merkleRoot)
      const recipientAddress = address(withdrawalProof.recipient)
      const amountBN = BigInt(withdrawalProof.amount)

      const programAddress = PRIVATE_TRANSFERS_PROGRAM_ADDRESS

      const [poolPda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [getBytesEncoder().encode(SEEDS.POOL)],
      })

      const [nullifierSetPda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [
          getBytesEncoder().encode(SEEDS.NULLIFIERS),
          getAddressEncoder().encode(poolPda),
        ],
      })

      const [poolVaultPda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [
          getBytesEncoder().encode(SEEDS.VAULT),
          getAddressEncoder().encode(poolPda),
        ],
      })

      const withdrawDataEncoder = getWithdrawInstructionDataEncoder()
      const instructionData = withdrawDataEncoder.encode({
        proof,
        nullifierHash,
        root,
        recipient: recipientAddress,
        amount: amountBN,
      })

      const withdrawInstruction = {
        programAddress,
        accounts: [
          { address: poolPda, role: 1 },
          { address: nullifierSetPda, role: 1 },
          { address: poolVaultPda, role: 1 },
          { address: recipientAddress, role: 1 },
          { address: SUNSPOT_VERIFIER_ID, role: 0 },
          { address: SYSTEM_PROGRAM_ID, role: 0 },
        ],
        data: instructionData,
      }

      const computeBudgetData = new Uint8Array(5)
      computeBudgetData[0] = 2
      new DataView(computeBudgetData.buffer).setUint32(1, ZK_VERIFY_COMPUTE_UNITS, true)

      const computeBudgetInstruction = {
        programAddress: COMPUTE_BUDGET_PROGRAM_ID,
        accounts: [] as const,
        data: computeBudgetData,
      }

      setStatus('Please sign the transaction in your wallet...')

      const result = await sendTransaction({
        instructions: [computeBudgetInstruction, withdrawInstruction],
      })

      if (result) {
        console.log('[Withdraw] Success:', result)
        setStatus(`Withdrawal successful! ${formatSol(amountBN)} SOL sent to ${recipient.slice(0, 8)}...`)
      } else {
        throw new Error('Transaction failed')
      }
    } catch (error) {
      console.error('[Withdraw] Error:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setLoading(false)
    }
  }

  const depositAmountSol = depositNote
    ? formatSol(BigInt(depositNote.amount))
    : '0'

  return (
    <div className="bg-[#1a1f2e] border border-[#2d3748] p-6 rounded-lg">
      <h2 className="text-xl font-semibold text-white mb-2">Withdraw</h2>

      {!depositNote ? (
        <div className="text-gray-500 text-center py-10">
          <p>Make a deposit first to enable withdrawal.</p>
          <p className="text-sm mt-2">Your deposit note will be saved automatically.</p>
        </div>
      ) : (
        <>
          <p className="text-gray-400 text-sm mb-5">
            Withdraw {depositAmountSol} SOL using your deposit note.
          </p>

          <div className="bg-[#14F195]/10 border border-[#14F195]/30 rounded p-3 mb-5">
            <p className="text-sm text-[#14F195]">
              Deposit note ready: {depositNote.commitment.slice(0, 16)}...
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Recipient Address
              </label>
              <input
                type="text"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="Solana address"
                className="w-full px-3 py-2 border border-[#2d3748] rounded font-mono text-sm bg-[#0e1116]"
                disabled={loading || isSending}
              />
            </div>

            {status && (
              <div className={`p-3 rounded text-sm ${
                status.includes('Error')
                  ? 'bg-red-900/30 text-red-400 border border-red-800'
                  : 'bg-[#9945FF]/10 text-[#9945FF] border border-[#9945FF]/30'
              }`}>
                {status}
              </div>
            )}

            <button
              onClick={handleWithdraw}
              disabled={!walletAddress || !depositNote || !recipient || loading || isSending}
              className="w-full px-4 py-3 btn-primary text-white rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading || isSending ? 'Processing...' : `Withdraw ${depositAmountSol} SOL`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
