import { parseAbi } from 'viem';

export const ERC20_ABI = parseAbi([
    'function decimals() view returns (uint8)',
    'function balanceOf(address _owner) view returns (uint256 balance)',
    'function transfer(address _to, uint256 _value) returns (bool)'
]);
