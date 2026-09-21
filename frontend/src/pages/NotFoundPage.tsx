import { ArrowLeft, FileQuestion } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Brand } from '../components/Brand'

export function NotFoundPage() {
  return <main className="not-found"><Brand /><div><FileQuestion aria-hidden="true" /><span>404 / KHÔNG TÌM THẤY</span><h1>Trang này nằm ngoài frontier.</h1><p>Đường dẫn không tồn tại trong WebLens hoặc đã được di chuyển.</p><Link className="button button--dark" to="/"><ArrowLeft />Về trang chủ</Link></div></main>
}
