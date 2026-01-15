import { useState } from 'react'
import { useWalletConnection } from '@solana/react-hooks'
import { getWalletAddress, truncateAddress } from '../utils'

export function WalletButton() {
  const { connectors, connect, disconnect, connecting, wallet } = useWalletConnection()
  const [showDropdown, setShowDropdown] = useState(false)

  const walletAddress = getWalletAddress(wallet)

  if (walletAddress) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-400 font-mono">
          {truncateAddress(walletAddress)}
        </span>
        <button
          onClick={() => disconnect()}
          className="px-4 py-2 text-sm text-gray-300 border border-[#2d3748] rounded hover:bg-[#1a1f2e] transition-colors"
        >
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        disabled={connecting}
        className="px-4 py-2 btn-primary text-white rounded disabled:opacity-50"
      >
        {connecting ? 'Connecting...' : 'Connect Wallet'}
      </button>
      {showDropdown && connectors.length > 0 && (
        <div className="absolute right-0 mt-2 w-48 bg-[#1a1f2e] border border-[#2d3748] rounded-lg shadow-xl z-10 overflow-hidden">
          {connectors.map((connector) => (
            <button
              key={connector.id}
              onClick={() => {
                connect(connector.id)
                setShowDropdown(false)
              }}
              className="block w-full text-left px-4 py-3 text-gray-300 hover:bg-[#2d3748] transition-colors"
            >
              {connector.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
